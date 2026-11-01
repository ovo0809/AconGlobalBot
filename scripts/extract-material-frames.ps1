param(
  [Parameter(Mandatory=$true)][string]$SourcePath,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$TimesJson
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$stage='LOAD_RUNTIME'
function Write-Event([hashtable]$Value){[Console]::Out.WriteLine(($Value|ConvertTo-Json -Compress -Depth 4));[Console]::Out.Flush()}

try {
  [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]|Out-Null
  [Windows.Storage.StorageFolder,Windows.Storage,ContentType=WindowsRuntime]|Out-Null
  [Windows.Storage.CreationCollisionOption,Windows.Storage,ContentType=WindowsRuntime]|Out-Null
  [Windows.Media.Transcoding.MediaTranscoder,Windows.Media.Transcoding,ContentType=WindowsRuntime]|Out-Null
  [Windows.Media.Transcoding.PrepareTranscodeResult,Windows.Media.Transcoding,ContentType=WindowsRuntime]|Out-Null
  [Windows.Media.MediaProperties.MediaEncodingProfile,Windows.Media,ContentType=WindowsRuntime]|Out-Null
  [Windows.Media.MediaProperties.VideoEncodingQuality,Windows.Media,ContentType=WindowsRuntime]|Out-Null
  [Windows.Storage.FileProperties.VideoProperties,Windows.Storage,ContentType=WindowsRuntime]|Out-Null
  [Windows.Media.Editing.MediaClip,Windows.Media.Editing,ContentType=WindowsRuntime]|Out-Null
  [Windows.Media.Editing.MediaComposition,Windows.Media.Editing,ContentType=WindowsRuntime]|Out-Null
  [Windows.Media.Editing.VideoFramePrecision,Windows.Media.Editing,ContentType=WindowsRuntime]|Out-Null
  [Windows.Graphics.Imaging.ImageStream,Windows.Graphics.Imaging,ContentType=WindowsRuntime]|Out-Null
  [System.Reflection.Assembly]::LoadWithPartialName('System.Runtime.WindowsRuntime')|Out-Null
  function Await-Operation($Operation,[Type]$ResultType){
    $method=[System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name-eq'AsTask'-and$_.IsGenericMethod-and$_.GetGenericArguments().Count-eq 1-and$_.GetParameters().Count-eq 1-and$_.ReturnType.IsGenericType}|Select-Object -First 1
    $task=$method.MakeGenericMethod($ResultType).Invoke($null,@($Operation));$task.Wait();return $task.Result
  }
  function Await-ProgressAction($Operation){
    $method=[System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name-eq'AsTask'-and$_.IsGenericMethod-and$_.GetGenericArguments().Count-eq 1-and$_.GetParameters().Count-eq 1-and-not$_.ReturnType.IsGenericType}|Select-Object -First 1
    $task=$method.MakeGenericMethod([double]).Invoke($null,@($Operation));$task.Wait()
  }
  $parsedTimes=$TimesJson|ConvertFrom-Json
  $times=@($parsedTimes|ForEach-Object{$_})
  if($times.Count-lt 1-or$times.Count-gt 6){throw 'INVALID_TIMES'}
  $stage='OPEN_SOURCE'
  $input=Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($SourcePath)) ([Windows.Storage.StorageFile])
  $properties=Await-Operation ($input.Properties.GetVideoPropertiesAsync()) ([Windows.Storage.FileProperties.VideoProperties])
  $sourceDuration=$properties.Duration.TotalSeconds;$width=[double]$properties.Width;$height=[double]$properties.Height
  if([double]::IsNaN($sourceDuration)-or[double]::IsInfinity($sourceDuration)-or$sourceDuration-le 0-or$width-lt 2-or$height-lt 2){throw 'INVALID_MEDIA'}
  $scale=[Math]::Min(1.0,1280.0/[Math]::Max($width,$height));$outputWidth=[Math]::Max(2,[int]([Math]::Floor(($width*$scale)/2)*2));$outputHeight=[Math]::Max(2,[int]([Math]::Floor(($height*$scale)/2)*2))
  # Browser-created MP4 files may have fragmented timestamps that MediaClip
  # cannot seek. Normalize once locally before requesting non-zero frames.
  $stage='NORMALIZE_SOURCE'
  $folder=Await-Operation ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($OutputDirectory)) ([Windows.Storage.StorageFolder])
  $normalized=Await-Operation ($folder.CreateFileAsync('normalized.mp4',[Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
  $profile=[Windows.Media.MediaProperties.MediaEncodingProfile]::CreateMp4([Windows.Media.MediaProperties.VideoEncodingQuality]::HD720p)
  $profile.Video.Width=$outputWidth;$profile.Video.Height=$outputHeight
  $normalizer=New-Object Windows.Media.Transcoding.MediaTranscoder;$normalizer.AlwaysReencode=$true;$normalizer.HardwareAccelerationEnabled=$true
  $normalizer.TrimStartTime=[TimeSpan]::Zero;$normalizer.TrimStopTime=[TimeSpan]::FromSeconds($sourceDuration)
  $preparation=Await-Operation ($normalizer.PrepareFileTranscodeAsync($input,$normalized,$profile)) ([Windows.Media.Transcoding.PrepareTranscodeResult])
  if(-not$preparation.CanTranscode){throw "UNSUPPORTED_MEDIA:$($preparation.FailureReason)"}
  Await-ProgressAction ($preparation.TranscodeAsync())
  $input=$normalized
  $probeClip=Await-Operation ([Windows.Media.Editing.MediaClip]::CreateFromFileAsync($input)) ([Windows.Media.Editing.MediaClip])
  $duration=$probeClip.OriginalDuration.TotalSeconds
  if([double]::IsNaN($duration)-or[double]::IsInfinity($duration)-or$duration-le 0){throw 'INVALID_MEDIA'}
  if([Math]::Abs($duration-$sourceDuration)-gt 1){throw 'NORMALIZED_DURATION_MISMATCH'}
  if($probeClip-is[IDisposable]){([IDisposable]$probeClip).Dispose()}
  # Windows PowerShell 5 does not project WinRT IVector<T>.Add. Invoke the
  # native vector Append method through its framework interface metadata.
  $stage='VECTOR_INTERFACE'
  $openVector=[System.Object].Assembly.GetType('System.Runtime.InteropServices.WindowsRuntime.IVector`1')
  $clipVector=$openVector.MakeGenericType([Windows.Media.Editing.MediaClip])
  $stage='GET_APPEND_METHOD'
  $append=$clipVector.GetMethod('Append')
  $frames=@()
  $stage='VALIDATE_TIME'
  for($index=0;$index-lt$times.Count;$index+=1){
    $time=[double]($times[$index])
    if([double]::IsNaN($time)-or[double]::IsInfinity($time)-or$time-lt 0-or$time-gt$duration){throw 'TIME_OUT_OF_RANGE'}
    $clip=$null;$thumbnail=$null
    try {
      # A MediaComposition thumbnail operation is single-use on Windows
      # PowerShell 5, so each requested timestamp gets its own clip/composition.
      $stage='CREATE_CLIP'
      $clip=Await-Operation ([Windows.Media.Editing.MediaClip]::CreateFromFileAsync($input)) ([Windows.Media.Editing.MediaClip])
      $clip.TrimTimeFromStart=[TimeSpan]::FromSeconds($time)
      $composition=New-Object Windows.Media.Editing.MediaComposition
      $stage='APPEND_CLIP'
      $append.Invoke($composition.Clips,@($clip))|Out-Null
      $stage='GET_THUMBNAIL'
      $thumbnail=Await-Operation ($composition.GetThumbnailAsync([TimeSpan]::Zero,$outputWidth,$outputHeight,[Windows.Media.Editing.VideoFramePrecision]::NearestFrame)) ([Windows.Graphics.Imaging.ImageStream])
      $stage='WRITE_THUMBNAIL'
      if($thumbnail.ContentType-ne'image/jpeg'){throw 'INVALID_FRAME'}
      $filename=('frame-{0:D3}.jpg'-f$index);$path=Join-Path $OutputDirectory $filename
      $sourceStream=[System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($thumbnail)
      try {$target=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$sourceStream.CopyTo($target)}finally{$target.Dispose()}}finally{$sourceStream.Dispose()}
      $size=(Get-Item -LiteralPath $path).Length;if($size-le 0-or$size-gt 8388608){throw 'INVALID_FRAME'}
      $frames+=@{index=$index;timeSeconds=$time;filename=$filename;bytes=[double]$size}
    } finally {if($null-ne$thumbnail){$stage='DISPOSE_THUMBNAIL';$thumbnail.Dispose()}}
  }
  Write-Event @{type='complete';frames=$frames}
} catch {
  $code="${stage}_FAILED";if($_.Exception.Message-match'^(INVALID_TIMES|INVALID_MEDIA|TIME_OUT_OF_RANGE|INVALID_FRAME)$'){$code=$Matches[1]}elseif($_.Exception.Message-match'^UNSUPPORTED_MEDIA:([A-Za-z]+)$'){$code="UNSUPPORTED_MEDIA:$($Matches[1])"}
  Write-Event @{type='error';code=$code};exit 1
}

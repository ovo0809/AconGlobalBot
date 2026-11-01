param(
  [Parameter(Mandatory=$true)][string]$SourcePath,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][ValidateRange(1,7200)][double]$MaxDurationSeconds,
  [ValidateRange(1,180)][double]$SegmentSeconds=180
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$stage='LOAD_RUNTIME'
function Write-Event([hashtable]$Value){[Console]::Out.WriteLine(($Value|ConvertTo-Json -Compress));[Console]::Out.Flush()}

try {
  [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]|Out-Null
  [Windows.Storage.StorageFolder,Windows.Storage,ContentType=WindowsRuntime]|Out-Null
  [Windows.Storage.CreationCollisionOption,Windows.Storage,ContentType=WindowsRuntime]|Out-Null
  [Windows.Media.Transcoding.MediaTranscoder,Windows.Media.Transcoding,ContentType=WindowsRuntime]|Out-Null
  [Windows.Media.Transcoding.PrepareTranscodeResult,Windows.Media.Transcoding,ContentType=WindowsRuntime]|Out-Null
  [Windows.Media.MediaProperties.MediaEncodingProfile,Windows.Media,ContentType=WindowsRuntime]|Out-Null
  [Windows.Media.MediaProperties.VideoEncodingQuality,Windows.Media,ContentType=WindowsRuntime]|Out-Null
  [Windows.Storage.FileProperties.VideoProperties,Windows.Storage,ContentType=WindowsRuntime]|Out-Null
  [Windows.Storage.FileProperties.BasicProperties,Windows.Storage,ContentType=WindowsRuntime]|Out-Null
  [System.Reflection.Assembly]::LoadWithPartialName('System.Runtime.WindowsRuntime')|Out-Null
  function Await-Operation($Operation,[Type]$ResultType){
    $method=[System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name-eq'AsTask'-and$_.IsGenericMethod-and$_.GetGenericArguments().Count-eq 1-and$_.GetParameters().Count-eq 1-and$_.ReturnType.IsGenericType}|Select-Object -First 1
    $task=$method.MakeGenericMethod($ResultType).Invoke($null,@($Operation));$task.Wait();return $task.Result
  }
  function Await-ProgressAction($Operation){
    $method=[System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name-eq'AsTask'-and$_.IsGenericMethod-and$_.GetGenericArguments().Count-eq 1-and$_.GetParameters().Count-eq 1-and-not$_.ReturnType.IsGenericType}|Select-Object -First 1
    $task=$method.MakeGenericMethod([double]).Invoke($null,@($Operation));$task.Wait()
  }
  function Get-AudioChannelCount([string]$Path){
    $shell=New-Object -ComObject Shell.Application
    $folder=$shell.Namespace([IO.Path]::GetDirectoryName($Path));if($null-eq$folder){return 0}
    $item=$folder.ParseName([IO.Path]::GetFileName($Path));if($null-eq$item){return 0}
    $channels=$item.ExtendedProperty('System.Audio.ChannelCount');if($null-eq$channels){return 0}
    return [Convert]::ToInt32($channels)
  }
  $stage='OPEN_SOURCE'
  $input=Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($SourcePath)) ([Windows.Storage.StorageFile])
  $stage='PROBE_VIDEO'
  $properties=Await-Operation ($input.Properties.GetVideoPropertiesAsync()) ([Windows.Storage.FileProperties.VideoProperties])
  $stage='PROBE_AUDIO'
  $sourceAudioChannels=Get-AudioChannelCount $SourcePath
  $stage='VALIDATE_SOURCE'
  $duration=$properties.Duration.TotalSeconds;$width=[double]$properties.Width;$height=[double]$properties.Height
  if([double]::IsNaN($duration)-or[double]::IsInfinity($duration)-or$duration-le 0){throw 'INVALID_DURATION'}
  if($duration-gt$MaxDurationSeconds){throw 'DURATION_LIMIT'}
  if($width-lt 2-or$height-lt 2){throw 'INVALID_DIMENSIONS'}
  $stage='VALIDATE_AUDIO'
  if($sourceAudioChannels -le 0){throw 'AUDIO_REQUIRED'}
  $scale=[Math]::Min(1.0,1280.0/[Math]::Max($width,$height))
  $outputWidth=[Math]::Max(2,[int]([Math]::Floor(($width*$scale)/2)*2));$outputHeight=[Math]::Max(2,[int]([Math]::Floor(($height*$scale)/2)*2))
  $folder=Await-Operation ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($OutputDirectory)) ([Windows.Storage.StorageFolder])
  function New-OutputProfile {
    $result=[Windows.Media.MediaProperties.MediaEncodingProfile]::CreateMp4([Windows.Media.MediaProperties.VideoEncodingQuality]::HD720p)
    $result.Video.Width=$outputWidth;$result.Video.Height=$outputHeight;$result.Video.Bitrate=900000;$result.Video.FrameRate.Numerator=30;$result.Video.FrameRate.Denominator=1
    if($null-eq$result.Audio){throw 'AUDIO_PROFILE_UNAVAILABLE'};$result.Audio.Bitrate=64000
    return $result
  }
  # Normalize fragmented/browser MP4 sources before seeking to non-zero ranges.
  $stage='NORMALIZE_SOURCE'
  $normalizedName='normalized.mp4'
  $normalized=Await-Operation ($folder.CreateFileAsync($normalizedName,[Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
  $normalizer=New-Object Windows.Media.Transcoding.MediaTranscoder;$normalizer.AlwaysReencode=$true;$normalizer.HardwareAccelerationEnabled=$true
  $normalizer.TrimStartTime=[TimeSpan]::Zero;$normalizer.TrimStopTime=[TimeSpan]::FromSeconds($duration)
  $normalization=Await-Operation ($normalizer.PrepareFileTranscodeAsync($input,$normalized,(New-OutputProfile))) ([Windows.Media.Transcoding.PrepareTranscodeResult])
  if(-not$normalization.CanTranscode){throw "UNSUPPORTED_MEDIA:$($normalization.FailureReason)"}
  Await-ProgressAction ($normalization.TranscodeAsync())
  $normalizedProperties=Await-Operation ($normalized.Properties.GetVideoPropertiesAsync()) ([Windows.Storage.FileProperties.VideoProperties])
  if((Get-AudioChannelCount (Join-Path $OutputDirectory $normalizedName)) -le 0){throw 'AUDIO_REQUIRED'}
  $normalizedDuration=$normalizedProperties.Duration.TotalSeconds
  if([Math]::Abs($normalizedDuration-$duration)-gt 1){throw 'NORMALIZED_DURATION_MISMATCH'}
  $duration=$normalizedDuration
  $count=[int][Math]::Ceiling($duration/$SegmentSeconds)
  Write-Event @{type='probed';durationSeconds=$duration;width=$properties.Width;height=$properties.Height;outputWidth=$outputWidth;outputHeight=$outputHeight;hasAudio=$true;segmentCount=$count}
  for($index=0;$index-lt$count;$index+=1){
    $stage='CREATE_OUTPUT'
    $start=$index*$SegmentSeconds;$end=[Math]::Min($duration,$start+$SegmentSeconds);$filename=('part-{0:D3}.mp4'-f$index)
    $segmentInput=Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Join-Path $OutputDirectory $normalizedName))) ([Windows.Storage.StorageFile])
    $output=Await-Operation ($folder.CreateFileAsync($filename,[Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
    $profile=New-OutputProfile
    $transcoder=New-Object Windows.Media.Transcoding.MediaTranscoder;$transcoder.AlwaysReencode=$true;$transcoder.HardwareAccelerationEnabled=$true
    $transcoder.TrimStartTime=[TimeSpan]::FromSeconds($start)
    # MediaTranscoder uses an absolute stop position here; verified with a
    # synthetic H.264/AAC source and a segment whose start is greater than zero.
    $transcoder.TrimStopTime=[TimeSpan]::FromSeconds($end)
    $stage='PREPARE_TRANSCODE'
    $prepared=Await-Operation ($transcoder.PrepareFileTranscodeAsync($segmentInput,$output,$profile)) ([Windows.Media.Transcoding.PrepareTranscodeResult])
    if(-not$prepared.CanTranscode){throw "UNSUPPORTED_MEDIA:$($prepared.FailureReason)"}
    $stage='RUN_TRANSCODE'
    Await-ProgressAction ($prepared.TranscodeAsync())
    $outputProperties=Await-Operation ($output.Properties.GetVideoPropertiesAsync()) ([Windows.Storage.FileProperties.VideoProperties])
    $basic=Await-Operation ($output.GetBasicPropertiesAsync()) ([Windows.Storage.FileProperties.BasicProperties])
    Write-Event @{type='segment';index=$index;filename=$filename;startSeconds=$start;endSeconds=$end;actualDurationSeconds=$outputProperties.Duration.TotalSeconds;bytes=[double]$basic.Size}
  }
  Write-Event @{type='complete';durationSeconds=$duration;segmentCount=$count}
} catch {
  $code="${stage}_FAILED";if($_.Exception.Message-match'^(INVALID_DURATION|DURATION_LIMIT|INVALID_DIMENSIONS|AUDIO_REQUIRED|AUDIO_PROFILE_UNAVAILABLE|NORMALIZED_DURATION_MISMATCH)$'){$code=$Matches[1]}elseif($_.Exception.Message-match'^UNSUPPORTED_MEDIA:([A-Za-z]+)$'){$code="UNSUPPORTED_MEDIA:$($Matches[1])"}
  Write-Event @{type='error';code=$code};exit 1
}

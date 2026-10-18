# Times one process on Windows for bench/platform.ts (measure). The Windows counterpart of
# /usr/bin/time: takes a JSON spec {file, args, cwd, env, out} and writes
# "<wall s> <user s> <sys s> <peak working set bytes> <exit code>" to spec.out.
# Wall time is a stopwatch around the process; CPU times and peak working set are read from
# its process handle after it exits (GetProcessTimes / GetProcessMemoryInfo). Child processes
# are not included. Works in Windows PowerShell 5.1 and PowerShell 7.
param([Parameter(Mandatory = $true)][string]$SpecPath)
$ErrorActionPreference = 'Stop'
$spec = Get-Content -Raw -LiteralPath $SpecPath | ConvertFrom-Json

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BenchProcessMemory {
	[StructLayout(LayoutKind.Sequential)]
	struct Counters {
		public uint cb; public uint PageFaultCount;
		public UIntPtr PeakWorkingSetSize; public UIntPtr WorkingSetSize;
		public UIntPtr QuotaPeakPagedPoolUsage; public UIntPtr QuotaPagedPoolUsage;
		public UIntPtr QuotaPeakNonPagedPoolUsage; public UIntPtr QuotaNonPagedPoolUsage;
		public UIntPtr PagefileUsage; public UIntPtr PeakPagefileUsage;
	}
	[DllImport("psapi.dll", SetLastError = true)]
	static extern bool GetProcessMemoryInfo(IntPtr process, out Counters counters, uint size);
	public static ulong PeakWorkingSet(IntPtr process) {
		Counters c;
		uint size = (uint)Marshal.SizeOf(typeof(Counters));
		if (!GetProcessMemoryInfo(process, out c, size)) throw new System.ComponentModel.Win32Exception();
		return (ulong)c.PeakWorkingSetSize;
	}
}
'@

# Windows command-line quoting (CommandLineToArgvW rules), since PowerShell 5.1 has no ArgumentList.
function Quote([string]$arg) {
	if ($arg -ne '' -and $arg -notmatch '[\s"]') { return $arg }
	$escaped = [regex]::Replace($arg, '(\\*)"', '$1$1\"')
	$escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
	return '"' + $escaped + '"'
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $spec.file
$psi.Arguments = (@($spec.args) | ForEach-Object { Quote $_ }) -join ' '
$psi.WorkingDirectory = $spec.cwd
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.EnvironmentVariables.Clear()
foreach ($entry in $spec.env.PSObject.Properties) { $psi.EnvironmentVariables[$entry.Name] = [string]$entry.Value }

$watch = [System.Diagnostics.Stopwatch]::StartNew()
$process = [System.Diagnostics.Process]::Start($psi)
# Drain both pipes so a chatty checker cannot block on a full buffer; the output is discarded.
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()
$process.WaitForExit()
$watch.Stop()
[void]$stdout.Result
[void]$stderr.Result

$peak = [BenchProcessMemory]::PeakWorkingSet($process.Handle)
# Invariant culture, so decimals are written with a dot whatever the system locale.
$line = [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0} {1} {2} {3} {4}', $watch.Elapsed.TotalSeconds, $process.UserProcessorTime.TotalSeconds, $process.PrivilegedProcessorTime.TotalSeconds, $peak, $process.ExitCode)
[System.IO.File]::WriteAllText($spec.out, $line)

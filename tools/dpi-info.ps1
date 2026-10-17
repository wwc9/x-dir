Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DM {
  [DllImport("user32.dll")] public static extern bool EnumDisplaySettings(string dev, uint mode, ref DEVMODE dm);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public ushort dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public uint dmFields;
    public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public ushort dmLogPixels;
    public uint dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
  }
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr hdc, int idx);
}
"@
$ps = [System.Windows.Forms.SystemInformation]::PrimaryScreenSize
Write-Host ("virtualized primary: $($ps.Width)x$($ps.Height)")
$dm = New-Object DM+DEVMODE
$dm.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($dm)
[void][DM]::EnumDisplaySettings($null, [uint32]4294967295, [ref]$dm)
Write-Host ("physical (ENUM_CURRENT_SETTINGS): $($dm.dmPelsWidth)x$($dm.dmPelsHeight) logpixels=$($dm.dmLogPixels)")
$hdc = [DM]::GetDC([IntPtr]::Zero)
Write-Host ("GetDeviceCaps LOGPIXELSX: " + [DM]::GetDeviceCaps($hdc, 88))

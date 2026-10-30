$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$publicDir = Join-Path $rootDir 'public'
if (-not (Test-Path $publicDir)) {
  New-Item -ItemType Directory -Path $publicDir -Force | Out-Null
}

$icoPath = Join-Path $publicDir 'voxel-orb.ico'
$exePath = Join-Path $rootDir ("$([char]0x542F)$([char]0x52A8)$([char]0x60AC)$([char]0x6D6E)$([char]0x7403).exe")
$lnkPath = Join-Path $rootDir ("AI Usage $([char]0x60AC)$([char]0x6D6E)$([char]0x7403).lnk")

$csharpIconBuilder = @"
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

public static class VoxelIconGenerator
{
    public static Bitmap RenderIconFrame(int size)
    {
        Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);

            float s = size / 256f;

            // 1. Outer circular / squircle dark Voxel HUD Orb base with neon border
            RectangleF orbRect = new RectangleF(14f * s, 14f * s, 228f * s, 228f * s);
            using (GraphicsPath orbPath = CreateRoundedRect(orbRect, 64f * s))
            {
                using (LinearGradientBrush bgBrush = new LinearGradientBrush(
                    orbRect,
                    Color.FromArgb(255, 19, 30, 56),
                    Color.FromArgb(255, 8, 13, 26),
                    45f))
                {
                    g.FillPath(bgBrush, orbPath);
                }

                // Subtle radial inner glow
                using (PathGradientBrush glowBrush = new PathGradientBrush(orbPath))
                {
                    glowBrush.CenterPoint = new PointF(128f * s, 96f * s);
                    glowBrush.CenterColor = Color.FromArgb(75, 79, 156, 249);
                    glowBrush.SurroundColors = new Color[] { Color.FromArgb(0, 10, 15, 29) };
                    g.FillPath(glowBrush, orbPath);
                }

                // Outer Voxel bevel rim
                using (LinearGradientBrush borderBrush = new LinearGradientBrush(
                    orbRect,
                    Color.FromArgb(255, 124, 156, 255),
                    Color.FromArgb(255, 59, 78, 118),
                    65f))
                using (Pen borderPen = new Pen(borderBrush, Math.Max(1.5f, 8f * s)))
                {
                    g.DrawPath(borderPen, orbPath);
                }
            }

            // 2. Draw 3 Voxel 3D Energy Pillars inside the Orb (Claude Orange, Gemini Blue, 3P Purple)
            // Left Pillar: Claude Orange (#FF855E)
            DrawVoxelPillar(
                g, s,
                44f, 86f, 44f, 112f,
                Color.FromArgb(255, 255, 171, 143),
                Color.FromArgb(255, 255, 133, 94),
                Color.FromArgb(255, 181, 74, 40)
            );

            // Center Pillar (Tallest): Antigravity Gemini Blue (#4F9CF9)
            DrawVoxelPillar(
                g, s,
                106f, 54f, 44f, 144f,
                Color.FromArgb(255, 147, 197, 253),
                Color.FromArgb(255, 79, 156, 249),
                Color.FromArgb(255, 29, 78, 216)
            );

            // Right Pillar: 3P Purple (#A78BFA)
            DrawVoxelPillar(
                g, s,
                168f, 74f, 44f, 124f,
                Color.FromArgb(255, 216, 180, 254),
                Color.FromArgb(255, 167, 139, 250),
                Color.FromArgb(255, 109, 40, 217)
            );

            // 3. Top Gold Live Pulse Badge (Today Spend / Active status indicator)
            float dotR = 16f * s;
            RectangleF dotRect = new RectangleF(192f * s - dotR, 46f * s - dotR, dotR * 2, dotR * 2);
            using (SolidBrush glowDot = new SolidBrush(Color.FromArgb(90, 251, 191, 36)))
            {
                g.FillEllipse(glowDot, dotRect.X - 6f * s, dotRect.Y - 6f * s, dotRect.Width + 12f * s, dotRect.Height + 12f * s);
            }
            using (LinearGradientBrush goldBrush = new LinearGradientBrush(
                dotRect,
                Color.FromArgb(255, 253, 224, 71),
                Color.FromArgb(255, 217, 119, 6),
                45f))
            {
                g.FillEllipse(goldBrush, dotRect);
            }
        }
        return bmp;
    }

    private static void DrawVoxelPillar(
        Graphics g, float s,
        float x, float y, float w, float h,
        Color topCapColor, Color mainColor, Color shadowColor)
    {
        RectangleF bodyRect = new RectangleF(x * s, y * s, w * s, h * s);
        float radius = 10f * s;

        // Drop shadow
        RectangleF shRect = new RectangleF((x + 3f) * s, (y + 6f) * s, w * s, h * s);
        using (GraphicsPath shPath = CreateRoundedRect(shRect, radius))
        using (SolidBrush shBrush = new SolidBrush(Color.FromArgb(120, 0, 0, 0)))
        {
            g.FillPath(shBrush, shPath);
        }

        // Main pillar body
        using (GraphicsPath bodyPath = CreateRoundedRect(bodyRect, radius))
        using (LinearGradientBrush bodyBrush = new LinearGradientBrush(
            bodyRect, topCapColor, mainColor, 90f))
        {
            g.FillPath(bodyBrush, bodyPath);

            // Bottom bevel extrusion
            RectangleF bottomBevel = new RectangleF(x * s, (y + h - 14f) * s, w * s, 14f * s);
            using (SolidBrush bevelBrush = new SolidBrush(shadowColor))
            {
                g.SetClip(bodyPath);
                g.FillRectangle(bevelBrush, bottomBevel);

                // Voxel horizontal energy segments
                using (Pen segPen = new Pen(Color.FromArgb(75, 10, 15, 29), Math.Max(1f, 3.5f * s)))
                {
                    for (float sy = y + 24f; sy < y + h - 16f; sy += 22f)
                    {
                        g.DrawLine(segPen, x * s, sy * s, (x + w) * s, sy * s);
                    }
                }

                // Top specular highlight
                RectangleF hiRect = new RectangleF((x + 4f) * s, (y + 4f) * s, (w - 8f) * s, 10f * s);
                using (SolidBrush hiBrush = new SolidBrush(Color.FromArgb(140, 255, 255, 255)))
                {
                    g.FillRectangle(hiBrush, hiRect);
                }
                g.ResetClip();
            }
        }
    }

    private static GraphicsPath CreateRoundedRect(RectangleF rect, float radius)
    {
        float d = radius * 2f;
        GraphicsPath path = new GraphicsPath();
        path.AddArc(rect.X, rect.Y, d, d, 180, 90);
        path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
        path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
        path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static void SaveMultiSizeIcon(string outputPath)
    {
        int[] sizes = new int[] { 256, 64, 48, 32, 16 };
        byte[][] pngBuffers = new byte[sizes.Length][];

        for (int i = 0; i < sizes.Length; i++)
        {
            using (Bitmap bmp = RenderIconFrame(sizes[i]))
            using (MemoryStream ms = new MemoryStream())
            {
                bmp.Save(ms, ImageFormat.Png);
                pngBuffers[i] = ms.ToArray();
            }
        }

        using (FileStream fs = new FileStream(outputPath, FileMode.Create, FileAccess.Write))
        using (BinaryWriter bw = new BinaryWriter(fs))
        {
            // ICONDIR header
            bw.Write((ushort)0); // Reserved
            bw.Write((ushort)1); // Type: 1 = ICO
            bw.Write((ushort)sizes.Length); // Image count

            int offset = 6 + (16 * sizes.Length);
            for (int i = 0; i < sizes.Length; i++)
            {
                int sz = sizes[i];
                bw.Write((byte)(sz >= 256 ? 0 : sz)); // Width
                bw.Write((byte)(sz >= 256 ? 0 : sz)); // Height
                bw.Write((byte)0); // Palette count
                bw.Write((byte)0); // Reserved
                bw.Write((ushort)1); // Color planes
                bw.Write((ushort)32); // Bits per pixel
                bw.Write((uint)pngBuffers[i].Length); // Data size
                bw.Write((uint)offset); // Data offset
                offset += pngBuffers[i].Length;
            }

            for (int i = 0; i < sizes.Length; i++)
            {
                bw.Write(pngBuffers[i]);
            }
        }
    }
}
"@

Add-Type -TypeDefinition $csharpIconBuilder -ReferencedAssemblies System.Drawing
[VoxelIconGenerator]::SaveMultiSizeIcon($icoPath)
Write-Output "Generated multi-size icon: $icoPath"

# Also compile a native Windows GUI launcher executable (启动悬浮球.exe) with the embedded custom icon!
$launcherCs = @"
using System;
using System.IO;
using System.Diagnostics;
using System.Reflection;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        try
        {
            string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string scriptPath = Path.Combine(exeDir, "src", "floating-ball.ps1");
            if (!File.Exists(scriptPath))
            {
                return;
            }
            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Sta -File \"" + scriptPath + "\"",
                WorkingDirectory = exeDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process.Start(psi);
        }
        catch
        {
        }
    }
}
"@

$cscPath = Join-Path ([System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
$tempCs = Join-Path $env:TEMP 'AiUsageFloatingBallLauncher.cs'
[System.IO.File]::WriteAllText($tempCs, $launcherCs, [System.Text.Encoding]::UTF8)

& $cscPath /nologo /target:winexe /optimize+ "/win32icon:$icoPath" "/out:$exePath" $tempCs
Remove-Item $tempCs -Force -ErrorAction SilentlyContinue
Write-Output "Compiled native launcher EXE with icon: $exePath"

# Also create a Windows .lnk shortcut with the custom icon
$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($lnkPath)
$sc.TargetPath = "powershell.exe"
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Sta -File `"$scriptDir\floating-ball.ps1`""
$sc.WorkingDirectory = $rootDir
$sc.WindowStyle = 7
$sc.IconLocation = "$icoPath,0"
$sc.Description = "AI Usage Voxel HUD - Real-time Desktop Floating Ball"
$sc.Save()
Write-Output "Created shortcut with icon: $lnkPath"

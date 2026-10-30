param(
  [int]$Port = 4321
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$serverScript = Join-Path $scriptDir 'server.mjs'

# Ensure single instance using a Local EventWaitHandle + Mutex
$wakeEventName = "Local\AiUsageFloatingBallWakeEvent_$Port"
$mutexName = "Local\AiUsageFloatingBallMutex_$Port"

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
  if (Test-Path $serverScript) {
    try {
      Start-Process -FilePath "node" -ArgumentList "`"$serverScript`"" -WorkingDirectory $rootDir -WindowStyle Hidden | Out-Null
    } catch {}
  }
  try {
    $evt = [System.Threading.EventWaitHandle]::OpenExisting($wakeEventName)
    $evt.Set() | Out-Null
  } catch {}
  exit 0
}

$wakeEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, $wakeEventName)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class Win32WindowHelper {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x00000080;

    public static void MakeToolWindow(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return;
        int exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
        if ((exStyle & WS_EX_TOOLWINDOW) == 0) {
            SetWindowLong(hWnd, GWL_EXSTYLE, exStyle | WS_EX_TOOLWINDOW);
        }
    }

    public static void KeepOnTop(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return;
        SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}
"@

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$dataDir = Join-Path $rootDir 'data'
if (-not (Test-Path $dataDir)) {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}
$stateFile = Join-Path $dataDir 'widget_state.json'
$uiJsonPath = Join-Path $scriptDir 'floating-ball-ui.json'
$serverScript = Join-Path $scriptDir 'server.mjs'

$uiTextRaw = [System.IO.File]::ReadAllText($uiJsonPath, [System.Text.Encoding]::UTF8)
$UI = $uiTextRaw | ConvertFrom-Json

# Load persisted widget state
$state = @{
  dockMode = 'taskbar'
  taskbarLeft = 152
  left = -1
  top = -1
  pinned = $false
  showRemaining = $true
  theme = 'dark'
  opacityIndex = 0
}
$opacityLevels = @(1.0, 0.85, 0.65)

if (Test-Path $stateFile) {
  try {
    $saved = [System.IO.File]::ReadAllText($stateFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($saved.dockMode -eq 'float' -or $saved.dockMode -eq 'taskbar') { $state.dockMode = [string]$saved.dockMode }
    if ($null -ne $saved.taskbarLeft -and [double]$saved.taskbarLeft -ge 0) { $state.taskbarLeft = [double]$saved.taskbarLeft }
    if ($null -ne $saved.left) { $state.left = [double]$saved.left }
    if ($null -ne $saved.top) { $state.top = [double]$saved.top }
    if ($null -ne $saved.pinned) { $state.pinned = [bool]$saved.pinned }
    if ($null -ne $saved.showRemaining) { $state.showRemaining = [bool]$saved.showRemaining }
    if ($saved.theme -eq 'light' -or $saved.theme -eq 'dark') { $state.theme = [string]$saved.theme }
    if ($null -ne $saved.opacityIndex) {
      $idx = [int]$saved.opacityIndex
      if ($idx -ge 0 -and $idx -lt $opacityLevels.Count) { $state.opacityIndex = $idx }
    }
  } catch {}
}

function Save-WidgetState {
  try {
    $json = $state | ConvertTo-Json -Depth 3
    [System.IO.File]::WriteAllText($stateFile, $json, [System.Text.Encoding]::UTF8)
  } catch {}
}

function New-Brush([string]$hex) {
  return [System.Windows.Media.BrushConverter]::new().ConvertFromString($hex)
}

function Format-Tokens([double]$n) {
  if ($n -ge 1000000) { return ("{0:N2}M" -f ($n / 1000000.0)) }
  if ($n -ge 1000) { return ("{0:N1}K" -f ($n / 1000.0)) }
  return ("{0:N0}" -f $n)
}

function Format-ResetCountdown([string]$isoStr, [int]$turns) {
  if ([string]::IsNullOrWhiteSpace($isoStr)) {
    if ($turns -le 0) { return $UI.noUsage }
    return "--"
  }
  try {
    $target = [DateTimeOffset]::Parse($isoStr).ToLocalTime()
    $now = [DateTimeOffset]::Now
    $diff = $target - $now
    if ($diff.TotalSeconds -le 0) { return $UI.noUsage }
    if ($diff.TotalDays -ge 1.0) {
      $d = [int][Math]::Floor($diff.TotalDays)
      $h = $diff.Hours
      return "$($UI.resetIn)${d}d ${h}h"
    }
    if ($diff.TotalHours -ge 1.0) {
      $h = [int][Math]::Floor($diff.TotalHours)
      $m = $diff.Minutes
      return "$($UI.resetIn)${h}h ${m}m"
    }
    $m = [Math]::Max(1, [int][Math]::Ceiling($diff.TotalMinutes))
    return "$($UI.resetIn)${m}m"
  } catch {
    return "--"
  }
}

# Build Floating Ball / Taskbar Bar Window XAML
$ballXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None"
        AllowsTransparency="True"
        Background="Transparent"
        Topmost="True"
        ShowInTaskbar="False"
        ResizeMode="NoResize"
        Width="406"
        Height="44">
  <Grid x:Name="BallOuterGrid" Margin="3,2,3,2">
    <Border x:Name="BallRoot"
            CornerRadius="8"
            BorderThickness="1"
            Background="#FA12141A"
            BorderBrush="#222631"
            Cursor="SizeAll">
      <Border.Effect>
        <DropShadowEffect BlurRadius="8" ShadowDepth="1.5" Direction="270" Color="#000000" Opacity="0.4"/>
      </Border.Effect>
      <Grid>
        <!-- Mode A: Taskbar Horizontal Strip Layout (400x40 inside 48px Taskbar) -->
        <Grid x:Name="TaskbarLayoutGrid" Margin="11,4,11,4" Visibility="Visible">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="114"/>
            <ColumnDefinition Width="11"/>
            <ColumnDefinition Width="*"/>
          </Grid.ColumnDefinitions>

          <!-- Left: Today Summary Compact Strip -->
          <StackPanel Grid.Column="0" VerticalAlignment="Center">
            <Grid Margin="0,0,0,2">
              <StackPanel Orientation="Horizontal" VerticalAlignment="Center" HorizontalAlignment="Left">
                <Ellipse x:Name="TbStatusDot" Width="5.5" Height="5.5" Fill="#4E9F6E" Margin="0,0,5,0" VerticalAlignment="Center"/>
                <TextBlock Text="TODAY" FontSize="8.5" FontWeight="Bold" Foreground="#8E95A2" FontFamily="Consolas" VerticalAlignment="Center"/>
              </StackPanel>
              <TextBlock x:Name="TbTodayTurns" Text="0T" FontSize="8.5" FontWeight="SemiBold" Foreground="#686F7C" FontFamily="Microsoft YaHei UI" HorizontalAlignment="Right" VerticalAlignment="Center"/>
            </Grid>
            <Grid>
              <TextBlock x:Name="TbTodayCost" Text="`$0.00" FontSize="12.5" FontWeight="Bold" Foreground="#F1F3F5" FontFamily="Consolas" HorizontalAlignment="Left" VerticalAlignment="Center"/>
              <TextBlock x:Name="TbTodayTokens" Text="0" FontSize="8.5" FontWeight="SemiBold" Foreground="#8E95A2" FontFamily="Consolas" HorizontalAlignment="Right" VerticalAlignment="Center"/>
            </Grid>
          </StackPanel>

          <!-- Divider -->
          <Border x:Name="TbDivider" Grid.Column="1" Width="1" Background="#222631" Margin="4,3,5,3"/>

          <!-- Right: 3 Horizontal Quota Pods (Claude 5H | Gemini 5H | 3P 5H) -->
          <UniformGrid Grid.Column="2" Rows="1" Columns="3" VerticalAlignment="Center">
            <!-- Pod 1: Claude 5H -->
            <StackPanel Margin="0,0,5,0" VerticalAlignment="Center">
              <Grid Margin="0,0,0,3.5">
                <TextBlock Text="C" FontSize="9" FontWeight="Bold" Foreground="#D97757" FontFamily="Consolas" HorizontalAlignment="Left" VerticalAlignment="Center"/>
                <TextBlock x:Name="TbTextC" Text="--%" FontSize="9" FontWeight="Bold" Foreground="#F1F3F5" FontFamily="Consolas" HorizontalAlignment="Right" VerticalAlignment="Center"/>
              </Grid>
              <Border x:Name="TbTrackC" Height="4" CornerRadius="2" Background="#1D212B" BorderThickness="0">
                <Border x:Name="TbFillC" HorizontalAlignment="Left" Width="0" CornerRadius="2" Background="#D97757"/>
              </Border>
            </StackPanel>

            <!-- Pod 2: Gemini 5H -->
            <StackPanel Margin="2.5,0,2.5,0" VerticalAlignment="Center">
              <Grid Margin="0,0,0,3.5">
                <TextBlock Text="G" FontSize="9" FontWeight="Bold" Foreground="#5E97F6" FontFamily="Consolas" HorizontalAlignment="Left" VerticalAlignment="Center"/>
                <TextBlock x:Name="TbTextG" Text="--%" FontSize="9" FontWeight="Bold" Foreground="#F1F3F5" FontFamily="Consolas" HorizontalAlignment="Right" VerticalAlignment="Center"/>
              </Grid>
              <Border x:Name="TbTrackG" Height="4" CornerRadius="2" Background="#1D212B" BorderThickness="0">
                <Border x:Name="TbFillG" HorizontalAlignment="Left" Width="0" CornerRadius="2" Background="#5E97F6"/>
              </Border>
            </StackPanel>

            <!-- Pod 3: 3P 5H -->
            <StackPanel Margin="5,0,0,0" VerticalAlignment="Center">
              <Grid Margin="0,0,0,3.5">
                <TextBlock Text="3P" FontSize="9" FontWeight="Bold" Foreground="#8B95C9" FontFamily="Consolas" HorizontalAlignment="Left" VerticalAlignment="Center"/>
                <TextBlock x:Name="TbTextTP" Text="--%" FontSize="9" FontWeight="Bold" Foreground="#F1F3F5" FontFamily="Consolas" HorizontalAlignment="Right" VerticalAlignment="Center"/>
              </Grid>
              <Border x:Name="TbTrackTP" Height="4" CornerRadius="2" Background="#1D212B" BorderThickness="0">
                <Border x:Name="TbFillTP" HorizontalAlignment="Left" Width="0" CornerRadius="2" Background="#8B95C9"/>
              </Border>
            </StackPanel>
          </UniformGrid>
        </Grid>

        <!-- Mode B: Free Floating Ball Layout (214x68) -->
        <Grid x:Name="FloatLayoutGrid" Margin="10,6,10,6" Visibility="Collapsed">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="70"/>
            <ColumnDefinition Width="11"/>
            <ColumnDefinition Width="*"/>
          </Grid.ColumnDefinitions>

          <!-- Left Today Summary Orb -->
          <StackPanel Grid.Column="0" VerticalAlignment="Center">
            <StackPanel Orientation="Horizontal" VerticalAlignment="Center" Margin="0,0,0,2">
              <Ellipse x:Name="StatusDot" Width="5.5" Height="5.5" Fill="#4E9F6E" Margin="0,0,5,0" VerticalAlignment="Center"/>
              <TextBlock x:Name="BallTodayLabel" Text="TODAY" FontSize="8.8" FontWeight="Bold" Foreground="#8E95A2" FontFamily="Consolas"/>
            </StackPanel>
            <TextBlock x:Name="BallTodayCost" Text="`$0.00" FontSize="13.5" FontWeight="Bold" Foreground="#F1F3F5" FontFamily="Consolas" Margin="0,0,0,1"/>
            <TextBlock x:Name="BallTodayTurns" Text="0T" FontSize="8.5" FontWeight="SemiBold" Foreground="#686F7C" FontFamily="Microsoft YaHei UI"/>
          </StackPanel>

          <!-- Divider -->
          <Border x:Name="BallDivider" Grid.Column="1" Width="1" Background="#222631" Margin="4,2,5,2"/>

          <!-- Right 3 Mini Quota Bars (Claude 5H, Gemini 5H, 3P 5H) -->
          <StackPanel Grid.Column="2" VerticalAlignment="Center">
            <!-- Row 1: Claude 5H -->
            <Grid Margin="0,0,0,4">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="18"/>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="32"/>
              </Grid.ColumnDefinitions>
              <TextBlock Grid.Column="0" Text="C" FontSize="9" FontWeight="Bold" Foreground="#D97757" FontFamily="Consolas" VerticalAlignment="Center"/>
              <Border x:Name="MiniTrackC" Grid.Column="1" Height="4" CornerRadius="2" Background="#1D212B" BorderThickness="0" VerticalAlignment="Center" Margin="2,0,4,0">
                <Border x:Name="MiniFillC" HorizontalAlignment="Left" Width="0" CornerRadius="2" Background="#D97757"/>
              </Border>
              <TextBlock x:Name="MiniTextC" Grid.Column="2" Text="--%" FontSize="9" FontWeight="Bold" Foreground="#F1F3F5" FontFamily="Consolas" HorizontalAlignment="Right" VerticalAlignment="Center"/>
            </Grid>

            <!-- Row 2: Gemini 5H -->
            <Grid Margin="0,0,0,4">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="18"/>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="32"/>
              </Grid.ColumnDefinitions>
              <TextBlock Grid.Column="0" Text="G" FontSize="9" FontWeight="Bold" Foreground="#5E97F6" FontFamily="Consolas" VerticalAlignment="Center"/>
              <Border x:Name="MiniTrackG" Grid.Column="1" Height="4" CornerRadius="2" Background="#1D212B" BorderThickness="0" VerticalAlignment="Center" Margin="2,0,4,0">
                <Border x:Name="MiniFillG" HorizontalAlignment="Left" Width="0" CornerRadius="2" Background="#5E97F6"/>
              </Border>
              <TextBlock x:Name="MiniTextG" Grid.Column="2" Text="--%" FontSize="9" FontWeight="Bold" Foreground="#F1F3F5" FontFamily="Consolas" HorizontalAlignment="Right" VerticalAlignment="Center"/>
            </Grid>

            <!-- Row 3: 3P 5H -->
            <Grid>
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="18"/>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="32"/>
              </Grid.ColumnDefinitions>
              <TextBlock Grid.Column="0" Text="3P" FontSize="9" FontWeight="Bold" Foreground="#8B95C9" FontFamily="Consolas" VerticalAlignment="Center"/>
              <Border x:Name="MiniTrackTP" Grid.Column="1" Height="4" CornerRadius="2" Background="#1D212B" BorderThickness="0" VerticalAlignment="Center" Margin="2,0,4,0">
                <Border x:Name="MiniFillTP" HorizontalAlignment="Left" Width="0" CornerRadius="2" Background="#8B95C9"/>
              </Border>
              <TextBlock x:Name="MiniTextTP" Grid.Column="2" Text="--%" FontSize="9" FontWeight="Bold" Foreground="#F1F3F5" FontFamily="Consolas" HorizontalAlignment="Right" VerticalAlignment="Center"/>
            </Grid>
          </StackPanel>
        </Grid>
      </Grid>
    </Border>
  </Grid>
</Window>
"@

# Build Expanded Mini HUD Window XAML (Concentric Radii: 12px Root -> 8px Card -> 6px Pod/Button -> 4px Badge)
$hudXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None"
        AllowsTransparency="True"
        Background="Transparent"
        Topmost="True"
        ShowInTaskbar="False"
        ResizeMode="NoResize"
        SizeToContent="Height"
        Width="386">
  <Window.Resources>
    <Style TargetType="Button">
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="BtnBorder"
                    CornerRadius="6"
                    Background="{TemplateBinding Background}"
                    BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="{TemplateBinding BorderThickness}"
                    Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="BtnBorder" Property="Opacity" Value="0.86"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Grid Margin="8">
    <Border x:Name="HudRoot"
            CornerRadius="12"
            BorderThickness="1"
            Background="#FC0B0C0F"
            BorderBrush="#222631"
            Padding="12">
      <Border.Effect>
        <DropShadowEffect BlurRadius="16" ShadowDepth="4" Direction="270" Color="#000000" Opacity="0.55"/>
      </Border.Effect>
      <StackPanel>
        <!-- Top Header Bar -->
        <Grid x:Name="HudHeaderBar" Background="Transparent" Cursor="SizeAll" Margin="0,0,0,8">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <StackPanel Grid.Column="0" Orientation="Horizontal" VerticalAlignment="Center">
            <TextBlock x:Name="HudTitleText" Text="DeepMind // AI Usage" FontSize="11.5" FontWeight="Bold" Foreground="#F1F3F5" FontFamily="Microsoft YaHei UI" VerticalAlignment="Center"/>
            <Border x:Name="SyncBadge" CornerRadius="4" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Padding="6,1.5" Margin="7,0,0,0" VerticalAlignment="Center">
              <TextBlock x:Name="SyncText" Text="SYNC..." FontSize="8.8" FontWeight="Bold" Foreground="#4E9F6E" FontFamily="Consolas"/>
            </Border>
          </StackPanel>
          <StackPanel Grid.Column="1" Orientation="Horizontal">
            <Button x:Name="BtnDockToggle" Content="TASKBAR" Height="22" Padding="8,0" FontSize="9.2" FontWeight="SemiBold" Foreground="#F1F3F5" Background="#181B22" BorderBrush="#262B38" BorderThickness="1" Cursor="Hand" Margin="0,0,4,0"/>
            <Button x:Name="BtnCloseHud" Content="X" Width="22" Height="22" FontSize="10.5" FontWeight="Bold" Foreground="#8E95A2" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Cursor="Hand"/>
          </StackPanel>
        </Grid>

        <!-- Action Toolbar Row -->
        <UniformGrid Rows="1" Columns="5" Margin="0,0,0,8">
          <Button x:Name="BtnModeToggle" Content="REM%" Height="24" FontSize="9.5" FontWeight="SemiBold" Foreground="#F1F3F5" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Cursor="Hand" Margin="0,0,3,0"/>
          <Button x:Name="BtnPinToggle" Content="PIN" Height="24" FontSize="9.5" FontWeight="SemiBold" Foreground="#F1F3F5" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Cursor="Hand" Margin="1,0,3,0"/>
          <Button x:Name="BtnThemeToggle" Content="THEME" Height="24" FontSize="9.5" FontWeight="SemiBold" Foreground="#F1F3F5" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Cursor="Hand" Margin="1,0,3,0"/>
          <Button x:Name="BtnRefreshNow" Content="SYNC" Height="24" FontSize="9.5" FontWeight="SemiBold" Foreground="#F1F3F5" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Cursor="Hand" Margin="1,0,3,0"/>
          <Button x:Name="BtnOpenWeb" Content="WEB" Height="24" FontSize="9.5" FontWeight="Bold" Foreground="#0B0C0F" Background="#F1F3F5" BorderBrush="#F1F3F5" BorderThickness="1" Cursor="Hand" Margin="1,0,0,0"/>
        </UniformGrid>

        <!-- Section 1: Today Live Spend Card (Unified Architectural Card Surface) -->
        <Border x:Name="CardToday" CornerRadius="8" BorderThickness="1" Background="#12141A" BorderBrush="#222631" Padding="10,8" Margin="0,0,0,8">
          <StackPanel>
            <Grid Margin="0,0,0,6">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="Auto"/>
              </Grid.ColumnDefinitions>
              <StackPanel Grid.Column="0">
                <TextBlock x:Name="TodayTitleText" Text="TODAY LIVE" FontSize="10" FontWeight="SemiBold" Foreground="#8E95A2" FontFamily="Microsoft YaHei UI"/>
                <StackPanel Orientation="Horizontal" Margin="0,2,0,0">
                  <TextBlock x:Name="HudTodayCost" Text="`$0.00" FontSize="18" FontWeight="Bold" Foreground="#F1F3F5" FontFamily="Consolas" VerticalAlignment="Bottom"/>
                  <TextBlock x:Name="HudTodayMeta" Text="0T / 0 Tok" FontSize="10" FontWeight="SemiBold" Foreground="#8E95A2" FontFamily="Consolas" VerticalAlignment="Bottom" Margin="8,0,0,2"/>
                </StackPanel>
              </StackPanel>
              <Border x:Name="TodaySavedBadge" Grid.Column="1" CornerRadius="4" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Padding="6,2" VerticalAlignment="Top">
                <TextBlock x:Name="HudTodaySaved" Text="`$0.00" FontSize="9" FontWeight="Bold" Foreground="#4E9F6E" FontFamily="Consolas"/>
              </Border>
            </Grid>

            <UniformGrid Rows="1" Columns="2">
              <Border x:Name="PodTodayClaude" CornerRadius="6" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Padding="7,4.5" Margin="0,0,3,0">
                <Grid>
                  <Grid.ColumnDefinitions>
                    <ColumnDefinition Width="*"/>
                    <ColumnDefinition Width="Auto"/>
                  </Grid.ColumnDefinitions>
                  <StackPanel Grid.Column="0" Orientation="Horizontal" VerticalAlignment="Center">
                    <Ellipse Width="5" Height="5" Fill="#D97757" Margin="0,0,5,0" VerticalAlignment="Center"/>
                    <TextBlock x:Name="LblTodayClaude" Text="Claude" FontSize="9.2" FontWeight="SemiBold" Foreground="#8E95A2" VerticalAlignment="Center"/>
                  </StackPanel>
                  <TextBlock x:Name="ValTodayClaude" Grid.Column="1" Text="`$0.00" FontSize="9.2" FontWeight="Bold" Foreground="#F1F3F5" FontFamily="Consolas" VerticalAlignment="Center"/>
                </Grid>
              </Border>
              <Border x:Name="PodTodayAgy" CornerRadius="6" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Padding="7,4.5" Margin="3,0,0,0">
                <Grid>
                  <Grid.ColumnDefinitions>
                    <ColumnDefinition Width="*"/>
                    <ColumnDefinition Width="Auto"/>
                  </Grid.ColumnDefinitions>
                  <StackPanel Grid.Column="0" Orientation="Horizontal" VerticalAlignment="Center">
                    <Ellipse Width="5" Height="5" Fill="#5E97F6" Margin="0,0,5,0" VerticalAlignment="Center"/>
                    <TextBlock x:Name="LblTodayAgy" Text="Antigravity" FontSize="9.2" FontWeight="SemiBold" Foreground="#8E95A2" VerticalAlignment="Center"/>
                  </StackPanel>
                  <TextBlock x:Name="ValTodayAgy" Grid.Column="1" Text="`$0.00" FontSize="9.2" FontWeight="Bold" Foreground="#F1F3F5" FontFamily="Consolas" VerticalAlignment="Center"/>
                </Grid>
              </Border>
            </UniformGrid>
          </StackPanel>
        </Border>

        <!-- Section 2: Claude Code / Desktop Quota Card -->
        <Border x:Name="CardClaude" CornerRadius="8" BorderThickness="1" Background="#12141A" BorderBrush="#222631" Padding="10,8" Margin="0,0,0,8">
          <StackPanel>
            <Grid Margin="0,0,0,6">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="Auto"/>
              </Grid.ColumnDefinitions>
              <StackPanel Grid.Column="0" Orientation="Horizontal" VerticalAlignment="Center">
                <Ellipse Width="6" Height="6" Fill="#D97757" Margin="0,0,6,0" VerticalAlignment="Center"/>
                <TextBlock x:Name="ClaudeHeaderTitle" Text="Claude Code / Desktop" FontSize="10.5" FontWeight="Bold" Foreground="#F1F3F5" FontFamily="Microsoft YaHei UI" VerticalAlignment="Center"/>
              </StackPanel>
              <Border x:Name="ClaudeRoiBadge" Grid.Column="1" CornerRadius="4" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Padding="6,1.5">
                <TextBlock x:Name="ClaudeRoiText" Text="ROI --%" FontSize="9" FontWeight="SemiBold" Foreground="#8E95A2" FontFamily="Consolas"/>
              </Border>
            </Grid>

            <UniformGrid Rows="1" Columns="2">
              <!-- Claude 5H Box -->
              <Border x:Name="BoxC5H" CornerRadius="6" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Padding="7,5.5" Margin="0,0,3,0">
                <StackPanel>
                  <Grid Margin="0,0,0,4">
                    <TextBlock x:Name="TitleC5H" Text="5H" FontSize="9.2" FontWeight="SemiBold" Foreground="#8E95A2" HorizontalAlignment="Left"/>
                    <TextBlock x:Name="PctC5H" Text="--%" FontSize="9.2" FontWeight="Bold" Foreground="#D97757" FontFamily="Consolas" HorizontalAlignment="Right"/>
                  </Grid>
                  <UniformGrid x:Name="BarC5H" Rows="1" Columns="12" Height="5" Margin="0,0,0,4"/>
                  <Grid>
                    <TextBlock x:Name="MetaC5H" Text="`$0/`$0" FontSize="8.5" Foreground="#686F7C" FontFamily="Consolas" HorizontalAlignment="Left"/>
                    <TextBlock x:Name="ResetC5H" Text="--" FontSize="8.5" FontWeight="SemiBold" Foreground="#8E95A2" FontFamily="Consolas" HorizontalAlignment="Right"/>
                  </Grid>
                </StackPanel>
              </Border>

              <!-- Claude 7D Box -->
              <Border x:Name="BoxC7D" CornerRadius="6" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Padding="7,5.5" Margin="3,0,0,0">
                <StackPanel>
                  <Grid Margin="0,0,0,4">
                    <TextBlock x:Name="TitleC7D" Text="7D" FontSize="9.2" FontWeight="SemiBold" Foreground="#8E95A2" HorizontalAlignment="Left"/>
                    <TextBlock x:Name="PctC7D" Text="--%" FontSize="9.2" FontWeight="Bold" Foreground="#D97757" FontFamily="Consolas" HorizontalAlignment="Right"/>
                  </Grid>
                  <UniformGrid x:Name="BarC7D" Rows="1" Columns="12" Height="5" Margin="0,0,0,4"/>
                  <Grid>
                    <TextBlock x:Name="MetaC7D" Text="`$0/`$0" FontSize="8.5" Foreground="#686F7C" FontFamily="Consolas" HorizontalAlignment="Left"/>
                    <TextBlock x:Name="ResetC7D" Text="--" FontSize="8.5" FontWeight="SemiBold" Foreground="#8E95A2" FontFamily="Consolas" HorizontalAlignment="Right"/>
                  </Grid>
                </StackPanel>
              </Border>
            </UniformGrid>
          </StackPanel>
        </Border>

        <!-- Section 3: Google Antigravity Dual Pool Quota Card -->
        <Border x:Name="CardAgy" CornerRadius="8" BorderThickness="1" Background="#12141A" BorderBrush="#222631" Padding="10,8" Margin="0,0,0,6">
          <StackPanel>
            <Grid Margin="0,0,0,6">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="Auto"/>
              </Grid.ColumnDefinitions>
              <StackPanel Grid.Column="0" Orientation="Horizontal" VerticalAlignment="Center">
                <Ellipse Width="6" Height="6" Fill="#5E97F6" Margin="0,0,6,0" VerticalAlignment="Center"/>
                <TextBlock x:Name="AgyHeaderTitle" Text="Google Antigravity" FontSize="10.5" FontWeight="Bold" Foreground="#F1F3F5" FontFamily="Microsoft YaHei UI" VerticalAlignment="Center"/>
              </StackPanel>
              <Border x:Name="AgyRoiBadge" Grid.Column="1" CornerRadius="4" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Padding="6,1.5">
                <TextBlock x:Name="AgyRoiText" Text="ROI --%" FontSize="9" FontWeight="SemiBold" Foreground="#8E95A2" FontFamily="Consolas"/>
              </Border>
            </Grid>

            <UniformGrid Rows="2" Columns="2">
              <!-- Gemini 5H Box -->
              <Border x:Name="BoxG5H" CornerRadius="6" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Padding="7,5.5" Margin="0,0,3,5">
                <StackPanel>
                  <Grid Margin="0,0,0,4">
                    <TextBlock x:Name="TitleG5H" Text="Gemini 5H" FontSize="9.2" FontWeight="SemiBold" Foreground="#8E95A2" HorizontalAlignment="Left"/>
                    <TextBlock x:Name="PctG5H" Text="--%" FontSize="9.2" FontWeight="Bold" Foreground="#5E97F6" FontFamily="Consolas" HorizontalAlignment="Right"/>
                  </Grid>
                  <UniformGrid x:Name="BarG5H" Rows="1" Columns="12" Height="5" Margin="0,0,0,4"/>
                  <Grid>
                    <TextBlock x:Name="MetaG5H" Text="`$0/`$0" FontSize="8.5" Foreground="#686F7C" FontFamily="Consolas" HorizontalAlignment="Left"/>
                    <TextBlock x:Name="ResetG5H" Text="--" FontSize="8.5" FontWeight="SemiBold" Foreground="#8E95A2" FontFamily="Consolas" HorizontalAlignment="Right"/>
                  </Grid>
                </StackPanel>
              </Border>

              <!-- Gemini 7D Box -->
              <Border x:Name="BoxG7D" CornerRadius="6" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Padding="7,5.5" Margin="3,0,0,5">
                <StackPanel>
                  <Grid Margin="0,0,0,4">
                    <TextBlock x:Name="TitleG7D" Text="Gemini 7D" FontSize="9.2" FontWeight="SemiBold" Foreground="#8E95A2" HorizontalAlignment="Left"/>
                    <TextBlock x:Name="PctG7D" Text="--%" FontSize="9.2" FontWeight="Bold" Foreground="#5E97F6" FontFamily="Consolas" HorizontalAlignment="Right"/>
                  </Grid>
                  <UniformGrid x:Name="BarG7D" Rows="1" Columns="12" Height="5" Margin="0,0,0,4"/>
                  <Grid>
                    <TextBlock x:Name="MetaG7D" Text="`$0/`$0" FontSize="8.5" Foreground="#686F7C" FontFamily="Consolas" HorizontalAlignment="Left"/>
                    <TextBlock x:Name="ResetG7D" Text="--" FontSize="8.5" FontWeight="SemiBold" Foreground="#8E95A2" FontFamily="Consolas" HorizontalAlignment="Right"/>
                  </Grid>
                </StackPanel>
              </Border>

              <!-- 3P 5H Box -->
              <Border x:Name="BoxTP5H" CornerRadius="6" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Padding="7,5.5" Margin="0,0,3,0">
                <StackPanel>
                  <Grid Margin="0,0,0,4">
                    <TextBlock x:Name="TitleTP5H" Text="3P 5H" FontSize="9.2" FontWeight="SemiBold" Foreground="#8E95A2" HorizontalAlignment="Left"/>
                    <TextBlock x:Name="PctTP5H" Text="--%" FontSize="9.2" FontWeight="Bold" Foreground="#8B95C9" FontFamily="Consolas" HorizontalAlignment="Right"/>
                  </Grid>
                  <UniformGrid x:Name="BarTP5H" Rows="1" Columns="12" Height="5" Margin="0,0,0,4"/>
                  <Grid>
                    <TextBlock x:Name="MetaTP5H" Text="`$0/`$0" FontSize="8.5" Foreground="#686F7C" FontFamily="Consolas" HorizontalAlignment="Left"/>
                    <TextBlock x:Name="ResetTP5H" Text="--" FontSize="8.5" FontWeight="SemiBold" Foreground="#8E95A2" FontFamily="Consolas" HorizontalAlignment="Right"/>
                  </Grid>
                </StackPanel>
              </Border>

              <!-- 3P 7D Box -->
              <Border x:Name="BoxTP7D" CornerRadius="6" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Padding="7,5.5" Margin="3,0,0,0">
                <StackPanel>
                  <Grid Margin="0,0,0,4">
                    <TextBlock x:Name="TitleTP7D" Text="3P 7D" FontSize="9.2" FontWeight="SemiBold" Foreground="#8E95A2" HorizontalAlignment="Left"/>
                    <TextBlock x:Name="PctTP7D" Text="--%" FontSize="9.2" FontWeight="Bold" Foreground="#8B95C9" FontFamily="Consolas" HorizontalAlignment="Right"/>
                  </Grid>
                  <UniformGrid x:Name="BarTP7D" Rows="1" Columns="12" Height="5" Margin="0,0,0,4"/>
                  <Grid>
                    <TextBlock x:Name="MetaTP7D" Text="`$0/`$0" FontSize="8.5" Foreground="#686F7C" FontFamily="Consolas" HorizontalAlignment="Left"/>
                    <TextBlock x:Name="ResetTP7D" Text="--" FontSize="8.5" FontWeight="SemiBold" Foreground="#8E95A2" FontFamily="Consolas" HorizontalAlignment="Right"/>
                  </Grid>
                </StackPanel>
              </Border>
            </UniformGrid>
          </StackPanel>
        </Border>

        <!-- Bottom Footer Bar -->
        <Grid Margin="0,2,0,0">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <TextBlock x:Name="FooterHintText" Grid.Column="0" Text="15s LIVE" FontSize="8.8" Foreground="#686F7C" VerticalAlignment="Center"/>
          <StackPanel Grid.Column="1" Orientation="Horizontal">
            <Button x:Name="BtnOpacity" Content="100%" Height="20" Padding="7,0" FontSize="8.8" Foreground="#8E95A2" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Cursor="Hand" Margin="0,0,4,0"/>
            <Button x:Name="BtnExitApp" Content="EXIT" Height="20" Padding="7,0" FontSize="8.8" Foreground="#D95C5C" Background="#181B22" BorderBrush="#222631" BorderThickness="1" Cursor="Hand"/>
          </StackPanel>
        </Grid>
      </StackPanel>
    </Border>
  </Grid>
</Window>
"@

$ballReader = New-Object System.Xml.XmlNodeReader ([xml]$ballXaml)
$ballWin = [Windows.Markup.XamlReader]::Load($ballReader)

$hudReader = New-Object System.Xml.XmlNodeReader ([xml]$hudXaml)
$hudWin = [Windows.Markup.XamlReader]::Load($hudReader)

# Bind named controls in Ball Window
$ctrlBall = @{}
foreach ($name in @(
  'BallOuterGrid', 'BallRoot', 'TaskbarLayoutGrid', 'FloatLayoutGrid',
  'TbStatusDot', 'TbTodayTurns', 'TbTodayCost', 'TbTodayTokens', 'TbDivider',
  'TbTrackC', 'TbFillC', 'TbTextC', 'TbTrackG', 'TbFillG', 'TbTextG', 'TbTrackTP', 'TbFillTP', 'TbTextTP',
  'StatusDot', 'BallTodayLabel', 'BallTodayCost', 'BallTodayTurns',
  'BallDivider', 'MiniTrackC', 'MiniFillC', 'MiniTextC',
  'MiniTrackG', 'MiniFillG', 'MiniTextG', 'MiniTrackTP', 'MiniFillTP', 'MiniTextTP'
)) {
  $ctrlBall[$name] = $ballWin.FindName($name)
}

# Bind named controls in HUD Window
$ctrlHud = @{}
foreach ($name in @(
  'HudRoot', 'HudHeaderBar', 'HudTitleText', 'SyncBadge', 'SyncText', 'BtnDockToggle', 'BtnCloseHud',
  'BtnModeToggle', 'BtnPinToggle', 'BtnThemeToggle', 'BtnRefreshNow', 'BtnOpenWeb',
  'CardToday', 'TodayTitleText', 'HudTodayCost', 'HudTodayMeta', 'HudTodaySaved',
  'PodTodayClaude', 'LblTodayClaude', 'ValTodayClaude',
  'PodTodayAgy', 'LblTodayAgy', 'ValTodayAgy',
  'CardClaude', 'ClaudeHeaderTitle', 'ClaudeRoiBadge', 'ClaudeRoiText',
  'BoxC5H', 'TitleC5H', 'PctC5H', 'BarC5H', 'MetaC5H', 'ResetC5H',
  'BoxC7D', 'TitleC7D', 'PctC7D', 'BarC7D', 'MetaC7D', 'ResetC7D',
  'CardAgy', 'AgyHeaderTitle', 'AgyRoiBadge', 'AgyRoiText',
  'BoxG5H', 'TitleG5H', 'PctG5H', 'BarG5H', 'MetaG5H', 'ResetG5H',
  'BoxG7D', 'TitleG7D', 'PctG7D', 'BarG7D', 'MetaG7D', 'ResetG7D',
  'BoxTP5H', 'TitleTP5H', 'PctTP5H', 'BarTP5H', 'MetaTP5H', 'ResetTP5H',
  'BoxTP7D', 'TitleTP7D', 'PctTP7D', 'BarTP7D', 'MetaTP7D', 'ResetTP7D',
  'FooterHintText', 'BtnOpacity', 'BtnExitApp'
)) {
  $ctrlHud[$name] = $hudWin.FindName($name)
}

# Apply localized UTF-8 labels from floating-ball-ui.json
$ctrlHud.HudTitleText.Text = $UI.hudTitle
$ctrlHud.SyncText.Text = $UI.syncing
$ctrlHud.BtnCloseHud.Content = $UI.btnClose
$ctrlHud.BtnThemeToggle.Content = $UI.btnTheme
$ctrlHud.BtnRefreshNow.Content = $UI.btnRefresh
$ctrlHud.BtnOpenWeb.Content = $UI.btnWeb
$ctrlHud.TodayTitleText.Text = $UI.todayTitle
$ctrlHud.LblTodayClaude.Text = $UI.todayClaude
$ctrlHud.LblTodayAgy.Text = $UI.todayAgy
$ctrlHud.ClaudeHeaderTitle.Text = $UI.claudeTitle
$ctrlHud.AgyHeaderTitle.Text = $UI.agyTitle
$ctrlHud.TitleC5H.Text = $UI.c5h
$ctrlHud.TitleC7D.Text = $UI.c7d
$ctrlHud.TitleG5H.Text = $UI.g5h
$ctrlHud.TitleG7D.Text = $UI.g7d
$ctrlHud.TitleTP5H.Text = $UI.tp5h
$ctrlHud.TitleTP7D.Text = $UI.tp7d
$ctrlHud.FooterHintText.Text = $UI.footerHint
$ctrlHud.BtnExitApp.Content = $UI.btnExit

# Pre-create 12 Voxel cells in each UniformGrid bar
$voxelBars = @{
  C5H  = @()
  C7D  = @()
  G5H  = @()
  G7D  = @()
  TP5H = @()
  TP7D = @()
}

foreach ($key in @('C5H', 'C7D', 'G5H', 'G7D', 'TP5H', 'TP7D')) {
  $grid = $ctrlHud["Bar$key"]
  $grid.Children.Clear()
  $cells = @()
  for ($i = 0; $i -lt 12; $i++) {
    $cell = New-Object System.Windows.Controls.Border
    $cell.CornerRadius = New-Object System.Windows.CornerRadius(1.5)
    $cell.Margin = New-Object System.Windows.Thickness(1, 0, 1, 0)
    $cell.Background = New-Brush "#222631"
    $grid.Children.Add($cell) | Out-Null
    $cells += $cell
  }
  $voxelBars[$key] = $cells
}

function Update-ButtonsState {
  if ($state.showRemaining) {
    $ctrlHud.BtnModeToggle.Content = $UI.btnModeRem
  } else {
    $ctrlHud.BtnModeToggle.Content = $UI.btnModeUsed
  }

  $isLight = ($state.theme -eq 'light')
  if ($state.pinned) {
    $ctrlHud.BtnPinToggle.Content = $UI.btnPinOn
    $ctrlHud.BtnPinToggle.BorderBrush = if ($isLight) { New-Brush "#94A3B8" } else { New-Brush "#5E6470" }
  } else {
    $ctrlHud.BtnPinToggle.Content = $UI.btnPinOff
    $ctrlHud.BtnPinToggle.BorderBrush = if ($isLight) { New-Brush "#DCE3EE" } else { New-Brush "#222631" }
  }

  if ($state.dockMode -eq 'taskbar') {
    $ctrlHud.BtnDockToggle.Content = $UI.btnDockFloat
    $ctrlHud.BtnDockToggle.Foreground = if ($isLight) { New-Brush "#111318" } else { New-Brush "#F1F3F5" }
    $ctrlHud.BtnDockToggle.BorderBrush = if ($isLight) { New-Brush "#CBD5E1" } else { New-Brush "#2E3342" }
  } else {
    $ctrlHud.BtnDockToggle.Content = $UI.btnDockTaskbar
    $ctrlHud.BtnDockToggle.Foreground = if ($isLight) { New-Brush "#2563EB" } else { New-Brush "#5E97F6" }
    $ctrlHud.BtnDockToggle.BorderBrush = if ($isLight) { New-Brush "#BFDBFE" } else { New-Brush "#2B3C5E" }
  }

  $opPct = [int][Math]::Round($opacityLevels[$state.opacityIndex] * 100)
  $ctrlHud.BtnOpacity.Content = "$($UI.opacityLabel)${opPct}%"
  $ballWin.Opacity = $opacityLevels[$state.opacityIndex]
  $hudWin.Opacity = [Math]::Min(1.0, $opacityLevels[$state.opacityIndex] + 0.08)
}

function Apply-Theme {
  $isLight = ($state.theme -eq 'light')
  if ($isLight) {
    $ctrlBall.BallRoot.Background = New-Brush "#FCFFFFFF"
    $ctrlBall.BallRoot.BorderBrush = New-Brush "#DCE3EE"
    $ctrlBall.BallDivider.Background = New-Brush "#E2E8F0"
    $ctrlBall.TbDivider.Background = New-Brush "#E2E8F0"
    $ctrlBall.BallTodayCost.Foreground = New-Brush "#111318"
    $ctrlBall.TbTodayCost.Foreground = New-Brush "#111318"
    foreach ($k in @('MiniTextC', 'MiniTextG', 'MiniTextTP', 'TbTextC', 'TbTextG', 'TbTextTP')) {
      $ctrlBall[$k].Foreground = New-Brush "#111318"
    }
    foreach ($k in @('MiniTrackC', 'MiniTrackG', 'MiniTrackTP', 'TbTrackC', 'TbTrackG', 'TbTrackTP')) {
      $ctrlBall[$k].Background = New-Brush "#E2E8F0"
    }

    $ctrlHud.HudRoot.Background = New-Brush "#FCFAFBFD"
    $ctrlHud.HudRoot.BorderBrush = New-Brush "#DCE3EE"
    $ctrlHud.HudTitleText.Foreground = New-Brush "#111318"
    $ctrlHud.CardToday.Background = New-Brush "#FFFFFF"
    $ctrlHud.CardToday.BorderBrush = New-Brush "#DCE3EE"
    $ctrlHud.HudTodayCost.Foreground = New-Brush "#111318"
    $ctrlHud.PodTodayClaude.Background = New-Brush "#F3F4F6"
    $ctrlHud.PodTodayClaude.BorderBrush = New-Brush "#E2E8F0"
    $ctrlHud.ValTodayClaude.Foreground = New-Brush "#111318"
    $ctrlHud.PodTodayAgy.Background = New-Brush "#F3F4F6"
    $ctrlHud.PodTodayAgy.BorderBrush = New-Brush "#E2E8F0"
    $ctrlHud.ValTodayAgy.Foreground = New-Brush "#111318"

    $ctrlHud.CardClaude.Background = New-Brush "#FFFFFF"
    $ctrlHud.CardClaude.BorderBrush = New-Brush "#DCE3EE"
    $ctrlHud.ClaudeHeaderTitle.Foreground = New-Brush "#111318"
    $ctrlHud.CardAgy.Background = New-Brush "#FFFFFF"
    $ctrlHud.CardAgy.BorderBrush = New-Brush "#DCE3EE"
    $ctrlHud.AgyHeaderTitle.Foreground = New-Brush "#111318"

    foreach ($b in @('BoxC5H', 'BoxC7D', 'BoxG5H', 'BoxG7D', 'BoxTP5H', 'BoxTP7D')) {
      $ctrlHud[$b].Background = New-Brush "#F3F4F6"
      $ctrlHud[$b].BorderBrush = New-Brush "#E2E8F0"
    }
    foreach ($t in @('TitleC5H', 'TitleC7D', 'TitleG5H', 'TitleG7D', 'TitleTP5H', 'TitleTP7D', 'ResetC5H', 'ResetC7D', 'ResetG5H', 'ResetG7D', 'ResetTP5H', 'ResetTP7D')) {
      $ctrlHud[$t].Foreground = New-Brush "#525866"
    }
  } else {
    $ctrlBall.BallRoot.Background = New-Brush "#FA12141A"
    $ctrlBall.BallRoot.BorderBrush = New-Brush "#222631"
    $ctrlBall.BallDivider.Background = New-Brush "#222631"
    $ctrlBall.TbDivider.Background = New-Brush "#222631"
    $ctrlBall.BallTodayCost.Foreground = New-Brush "#F1F3F5"
    $ctrlBall.TbTodayCost.Foreground = New-Brush "#F1F3F5"
    foreach ($k in @('MiniTextC', 'MiniTextG', 'MiniTextTP', 'TbTextC', 'TbTextG', 'TbTextTP')) {
      $ctrlBall[$k].Foreground = New-Brush "#F1F3F5"
    }
    foreach ($k in @('MiniTrackC', 'MiniTrackG', 'MiniTrackTP', 'TbTrackC', 'TbTrackG', 'TbTrackTP')) {
      $ctrlBall[$k].Background = New-Brush "#1D212B"
    }

    $ctrlHud.HudRoot.Background = New-Brush "#FC0B0C0F"
    $ctrlHud.HudRoot.BorderBrush = New-Brush "#222631"
    $ctrlHud.HudTitleText.Foreground = New-Brush "#F1F3F5"
    $ctrlHud.CardToday.Background = New-Brush "#12141A"
    $ctrlHud.CardToday.BorderBrush = New-Brush "#222631"
    $ctrlHud.HudTodayCost.Foreground = New-Brush "#F1F3F5"
    $ctrlHud.PodTodayClaude.Background = New-Brush "#181B22"
    $ctrlHud.PodTodayClaude.BorderBrush = New-Brush "#222631"
    $ctrlHud.ValTodayClaude.Foreground = New-Brush "#F1F3F5"
    $ctrlHud.PodTodayAgy.Background = New-Brush "#181B22"
    $ctrlHud.PodTodayAgy.BorderBrush = New-Brush "#222631"
    $ctrlHud.ValTodayAgy.Foreground = New-Brush "#F1F3F5"

    $ctrlHud.CardClaude.Background = New-Brush "#12141A"
    $ctrlHud.CardClaude.BorderBrush = New-Brush "#222631"
    $ctrlHud.ClaudeHeaderTitle.Foreground = New-Brush "#F1F3F5"
    $ctrlHud.CardAgy.Background = New-Brush "#12141A"
    $ctrlHud.CardAgy.BorderBrush = New-Brush "#222631"
    $ctrlHud.AgyHeaderTitle.Foreground = New-Brush "#F1F3F5"

    foreach ($b in @('BoxC5H', 'BoxC7D', 'BoxG5H', 'BoxG7D', 'BoxTP5H', 'BoxTP7D')) {
      $ctrlHud[$b].Background = New-Brush "#181B22"
      $ctrlHud[$b].BorderBrush = New-Brush "#222631"
    }
    foreach ($t in @('TitleC5H', 'TitleC7D', 'TitleG5H', 'TitleG7D', 'TitleTP5H', 'TitleTP7D', 'ResetC5H', 'ResetC7D', 'ResetG5H', 'ResetG7D', 'ResetTP5H', 'ResetTP7D')) {
      $ctrlHud[$t].Foreground = New-Brush "#8E95A2"
    }
  }
  Update-ButtonsState
}

function Get-TaskbarTop {
  $wa = [System.Windows.SystemParameters]::WorkArea
  $screenH = [System.Windows.SystemParameters]::PrimaryScreenHeight
  $tbHeight = $screenH - $wa.Bottom
  if ($tbHeight -lt 32) { $tbHeight = 48 }
  return ($wa.Bottom + [Math]::Round(($tbHeight - 44.0) / 2.0))
}

function Apply-DockMode {
  $wa = [System.Windows.SystemParameters]::WorkArea
  $screenW = [System.Windows.SystemParameters]::PrimaryScreenWidth
  if ($state.dockMode -eq 'taskbar') {
    $ballWin.Width = 406
    $ballWin.Height = 44
    $ctrlBall.BallOuterGrid.Margin = New-Object System.Windows.Thickness(3, 2, 3, 2)
    $ctrlBall.BallRoot.CornerRadius = New-Object System.Windows.CornerRadius(8)
    $ctrlBall.BallRoot.BorderThickness = New-Object System.Windows.Thickness(1)
    $ctrlBall.TaskbarLayoutGrid.Visibility = [System.Windows.Visibility]::Visible
    $ctrlBall.FloatLayoutGrid.Visibility = [System.Windows.Visibility]::Collapsed

    if ($state.taskbarLeft -lt 0 -or $state.taskbarLeft -gt ($screenW - $ballWin.Width - 10)) {
      $state.taskbarLeft = 152
    }
    $ballWin.Left = [Math]::Max(4, [Math]::Min($state.taskbarLeft, $screenW - $ballWin.Width - 4))
    $ballWin.Top = Get-TaskbarTop
  } else {
    $ballWin.Width = 214
    $ballWin.Height = 68
    $ctrlBall.BallOuterGrid.Margin = New-Object System.Windows.Thickness(5)
    $ctrlBall.BallRoot.CornerRadius = New-Object System.Windows.CornerRadius(10)
    $ctrlBall.BallRoot.BorderThickness = New-Object System.Windows.Thickness(1)
    $ctrlBall.TaskbarLayoutGrid.Visibility = [System.Windows.Visibility]::Collapsed
    $ctrlBall.FloatLayoutGrid.Visibility = [System.Windows.Visibility]::Visible

    if ($state.left -lt 0 -or $state.top -lt 0 -or $state.left -gt ($wa.Right - 60) -or $state.top -gt ($wa.Bottom - 30)) {
      $state.left = [Math]::Max(20, $wa.Right - $ballWin.Width - 24)
      $state.top = [Math]::Max(20, $wa.Top + 72)
    }
    $ballWin.Left = $state.left
    $ballWin.Top = $state.top
  }
  Update-ButtonsState
  try { $ballWin.UpdateLayout() } catch {}
  if ($null -ne $script:lastSnapshot) {
    Render-Snapshot $script:lastSnapshot
  }
  if ($hudWin.Visibility -eq [System.Windows.Visibility]::Visible) {
    Update-HudPosition
  }
}

function Update-HudPosition {
  $wa = [System.Windows.SystemParameters]::WorkArea
  $bLeft = $ballWin.Left
  $bTop = $ballWin.Top
  $bW = $ballWin.ActualWidth
  if ($bW -le 0) { $bW = $ballWin.Width }
  $bH = $ballWin.ActualHeight
  if ($bH -le 0) { $bH = $ballWin.Height }

  $hW = $hudWin.ActualWidth
  if ($hW -le 0) { $hW = $hudWin.Width }
  $hH = $hudWin.ActualHeight
  if ($hH -le 0) { $hH = 415 }

  if ($state.dockMode -eq 'taskbar') {
    $targetLeft = [Math]::Max($wa.Left + 8, [Math]::Min($bLeft + 6, $wa.Right - $hW - 8))
    $targetTop = [Math]::Max($wa.Top + 8, $wa.Bottom - $hH + 4)
  } else {
    # Horizontal alignment: if ball is on right half of screen, align right edges; otherwise align left edges
    if (($bLeft + ($bW / 2)) -gt ($wa.Left + ($wa.Width / 2))) {
      $targetLeft = $bLeft + $bW - $hW
    } else {
      $targetLeft = $bLeft
    }
    $targetLeft = [Math]::Max($wa.Left + 8, [Math]::Min($targetLeft, $wa.Right - $hW - 8))

    # Vertical alignment: place below ball unless near bottom edge
    if (($bTop + $bH + $hH - 4) -le $wa.Bottom) {
      $targetTop = $bTop + $bH - 6
    } else {
      $targetTop = [Math]::Max($wa.Top + 8, $bTop - $hH + 6)
    }
  }

  $hudWin.Left = $targetLeft
  $hudWin.Top = $targetTop
}

function Show-HudPanel {
  Update-HudPosition
  if ($hudWin.Visibility -ne [System.Windows.Visibility]::Visible) {
    $hudWin.Show()
    Update-HudPosition
  }
}

function Hide-HudPanel {
  if ($hudWin.Visibility -eq [System.Windows.Visibility]::Visible) {
    $hudWin.Hide()
  }
}

# Helper to update a 12-cell Voxel Bar and Mini Track
function Set-QuotaMeter(
  [string]$key,
  [double]$usedPct,
  [double]$remPct,
  [double]$costUsd,
  [double]$budgetUsd,
  [int]$turns,
  [string]$resetsAt,
  [string]$baseColorHex
) {
  $usedClamped = [Math]::Max(0.0, [Math]::Min(100.0, $usedPct))
  $remClamped = [Math]::Max(0.0, [Math]::Min(100.0, $remPct))

  $activeColor = $baseColorHex
  if ($usedClamped -ge 85.0) {
    $activeColor = "#D95C5C"
  } elseif ($usedClamped -ge 65.0) {
    $activeColor = "#D49B35"
  }

  $displayPct = if ($state.showRemaining) {
    "$($UI.remPrefix)$([Math]::Round($remClamped))%"
  } else {
    "$($UI.usedPrefix)$([Math]::Round($usedClamped))%"
  }

  $ctrlHud["Pct$key"].Text = $displayPct
  $ctrlHud["Pct$key"].Foreground = New-Brush $activeColor
  $ctrlHud["Meta$key"].Text = "${turns}$($UI.turnsUnit) / `$$("{0:N1}" -f $costUsd)/`$$("{0:N0}" -f $budgetUsd)"
  $ctrlHud["Reset$key"].Text = Format-ResetCountdown $resetsAt $turns

  # Fill fraction: if showRemaining is true, show remaining energy cells; otherwise show used cells
  $fillPct = if ($state.showRemaining) { $remClamped } else { $usedClamped }
  $activeCells = [int][Math]::Round(($fillPct / 100.0) * 12.0)
  if ($fillPct -gt 0 -and $activeCells -eq 0) { $activeCells = 1 }

  $offHex = if ($state.theme -eq 'light') { "#E2E8F0" } else { "#222631" }
  $offBrush = New-Brush $offHex
  $onBrush = New-Brush $activeColor

  $cells = $voxelBars[$key]
  for ($i = 0; $i -lt 12; $i++) {
    if ($i -lt $activeCells) {
      $cells[$i].Background = $onBrush
    } else {
      $cells[$i].Background = $offBrush
    }
  }
}

function Set-MiniBallBar([string]$suffix, [double]$usedPct, [double]$remPct, [string]$baseHex) {
  $usedClamped = [Math]::Max(0.0, [Math]::Min(100.0, $usedPct))
  $remClamped = [Math]::Max(0.0, [Math]::Min(100.0, $remPct))
  $fillPct = if ($state.showRemaining) { $remClamped } else { $usedClamped }

  $colorHex = $baseHex
  if ($usedClamped -ge 85.0) {
    $colorHex = "#D95C5C"
  } elseif ($usedClamped -ge 65.0) {
    $colorHex = "#D49B35"
  }
  $colorBrush = New-Brush $colorHex
  $pctStr = "$([int][Math]::Round($fillPct))%"

  # Update Float Ball Mini Bar
  $track = $ctrlBall["MiniTrack$suffix"]
  $fill = $ctrlBall["MiniFill$suffix"]
  $txt = $ctrlBall["MiniText$suffix"]
  $maxW = $track.ActualWidth
  if ($maxW -le 10) { $maxW = 54 }
  $fill.Width = [Math]::Max(0.0, ($fillPct / 100.0) * $maxW)
  $fill.Background = $colorBrush
  $txt.Text = $pctStr

  # Update Taskbar Strip Mini Bar
  $tbTrack = $ctrlBall["TbTrack$suffix"]
  $tbFill = $ctrlBall["TbFill$suffix"]
  $tbTxt = $ctrlBall["TbText$suffix"]
  $tbMaxW = $tbTrack.ActualWidth
  if ($tbMaxW -le 10) { $tbMaxW = 76 }
  $tbFill.Width = [Math]::Max(0.0, ($fillPct / 100.0) * $tbMaxW)
  $tbFill.Background = $colorBrush
  $tbTxt.Text = $pctStr
}

$script:lastSnapshot = $null

function Render-Snapshot($snap) {
  if ($null -eq $snap) { return }
  $script:lastSnapshot = $snap

  $nowStr = (Get-Date).ToString("HH:mm:ss")
  $ctrlHud.SyncText.Text = "LIVE $nowStr"
  $ctrlHud.SyncText.Foreground = New-Brush "#4E9F6E"

  # 1. Today Stats
  $ts = $snap.todayStats
  if ($null -ne $ts) {
    $todayCost = [double]$ts.combined.costUsd
    $todayTurns = [int]$ts.combined.turns
    $todayTokens = [double]$ts.combined.totalTokens
    $todaySaved = [double]$ts.combined.cacheSavingsUsd

    $costFormatted = ("`${0:N2}" -f $todayCost)
    $tokFormatted = Format-Tokens $todayTokens

    $ctrlBall.BallTodayCost.Text = $costFormatted
    $ctrlBall.BallTodayTurns.Text = "${todayTurns}$($UI.turnsUnit) / $tokFormatted"

    $ctrlBall.TbTodayCost.Text = $costFormatted
    $ctrlBall.TbTodayTurns.Text = "${todayTurns}$($UI.turnsUnit)"
    $ctrlBall.TbTodayTokens.Text = $tokFormatted

    $ctrlHud.HudTodayCost.Text = $costFormatted
    $ctrlHud.HudTodayMeta.Text = "${todayTurns} $($UI.turnsUnit) / $tokFormatted Tok"
    $ctrlHud.HudTodaySaved.Text = "$($UI.savedPrefix)$("{0:N2}" -f $todaySaved)"

    $cCost = [double]$ts.claude.costUsd
    $cTurns = [int]$ts.claude.turns
    $ctrlHud.ValTodayClaude.Text = ("`${0:N2} ({1}$($UI.turnsUnit))" -f $cCost, $cTurns)

    $aCost = [double]$ts.antigravity.costUsd
    $aTurns = [int]$ts.antigravity.turns
    $ctrlHud.ValTodayAgy.Text = ("`${0:N2} ({1}$($UI.turnsUnit))" -f $aCost, $aTurns)
  }

  # 2. Claude Quota
  $qc = $snap.quotaStatus.claude
  $c5Used = 0.0
  if ($null -ne $qc) {
    $c5Used = [double]$qc.fiveHour.usedPercentage
    $c5Rem = [double]$qc.fiveHour.remainingPercentage
    $c7Used = [double]$qc.sevenDay.usedPercentage
    $c7Rem = [double]$qc.sevenDay.remainingPercentage

    $planShort = ($qc.planName -split ' ')[0..1] -join ' '
    $ctrlHud.ClaudeRoiText.Text = "$planShort | $($UI.roiPrefix)$([int]$qc.thirtyDay.roiPercentage)%"

    Set-QuotaMeter 'C5H' $c5Used $c5Rem ([double]$qc.fiveHour.costUsd) ([double]$qc.fiveHourBudgetUsd) ([int]$qc.fiveHour.turns) ([string]$qc.fiveHour.resetsAt) "#D97757"
    Set-QuotaMeter 'C7D' $c7Used $c7Rem ([double]$qc.sevenDay.costUsd) ([double]$qc.sevenDayBudgetUsd) ([int]$qc.sevenDay.turns) ([string]$qc.sevenDay.resetsAt) "#D97757"
    Set-MiniBallBar 'C' $c5Used $c5Rem "#D97757"
  }

  # 3. Antigravity Quota (Gemini + 3P)
  $qa = $snap.quotaStatus.antigravity
  $g5Used = 0.0
  $tp5Used = 0.0
  if ($null -ne $qa) {
    $g5Used = [double]$qa.fiveHour.usedPercentage
    $g5Rem = if ($null -ne $qa.fiveHour.nativeRemainingPct) { [double]$qa.fiveHour.nativeRemainingPct } else { [double]$qa.fiveHour.remainingPercentage }
    $g7Used = [double]$qa.sevenDay.usedPercentage
    $g7Rem = if ($null -ne $qa.sevenDay.nativeRemainingPct) { [double]$qa.sevenDay.nativeRemainingPct } else { [double]$qa.sevenDay.remainingPercentage }

    $ctrlHud.AgyRoiText.Text = "$($UI.roiPrefix)$([int]$qa.thirtyDay.roiPercentage)% ($("{0:N1}" -f [double]$qa.thirtyDay.roiMultiplier)x)"

    Set-QuotaMeter 'G5H' $g5Used $g5Rem ([double]$qa.fiveHour.costUsd) ([double]$qa.fiveHourBudgetUsd) ([int]$qa.fiveHour.turns) ([string]$qa.fiveHour.resetsAt) "#5E97F6"
    Set-QuotaMeter 'G7D' $g7Used $g7Rem ([double]$qa.sevenDay.costUsd) ([double]$qa.sevenDayBudgetUsd) ([int]$qa.sevenDay.turns) ([string]$qa.sevenDay.resetsAt) "#5E97F6"
    Set-MiniBallBar 'G' $g5Used $g5Rem "#5E97F6"

    if ($null -ne $qa.thirdParty) {
      $tp = $qa.thirdParty
      $tp5Used = [double]$tp.fiveHour.usedPercentage
      $tp5Rem = if ($null -ne $tp.fiveHour.nativeRemainingPct) { [double]$tp.fiveHour.nativeRemainingPct } else { [double]$tp.fiveHour.remainingPercentage }
      $tp7Used = [double]$tp.sevenDay.usedPercentage
      $tp7Rem = if ($null -ne $tp.sevenDay.nativeRemainingPct) { [double]$tp.sevenDay.nativeRemainingPct } else { [double]$tp.sevenDay.remainingPercentage }

      Set-QuotaMeter 'TP5H' $tp5Used $tp5Rem ([double]$tp.fiveHour.costUsd) ([double]$tp.fiveHourBudgetUsd) ([int]$tp.fiveHour.turns) ([string]$tp.fiveHour.resetsAt) "#8B95C9"
      Set-QuotaMeter 'TP7D' $tp7Used $tp7Rem ([double]$tp.sevenDay.costUsd) ([double]$tp.sevenDayBudgetUsd) ([int]$tp.sevenDay.turns) ([string]$tp.sevenDay.resetsAt) "#8B95C9"
      Set-MiniBallBar 'TP' $tp5Used $tp5Rem "#8B95C9"
    }
  }

  # Status Dot color by max 5h usage
  $maxUsed = [Math]::Max($c5Used, [Math]::Max($g5Used, $tp5Used))
  $dotBrush = if ($maxUsed -ge 85.0) {
    New-Brush "#D95C5C"
  } elseif ($maxUsed -ge 65.0) {
    New-Brush "#D49B35"
  } else {
    New-Brush "#4E9F6E"
  }
  $ctrlBall.StatusDot.Fill = $dotBrush
  $ctrlBall.TbStatusDot.Fill = $dotBrush
}

# Async HTTP Client & Auto-Start Server Logic
$httpClient = New-Object System.Net.Http.HttpClient
$httpClient.Timeout = [TimeSpan]::FromSeconds(8)
$apiUrl = "http://127.0.0.1:$Port/api/snapshot?days=today"
$webUrl = "http://127.0.0.1:$Port"

$script:pendingTask = $null
$script:lastFetchTime = [DateTime]::MinValue
$script:serverStartAttempted = $false

function Start-BackendServerIfNeeded {
  if ($script:serverStartAttempted) { return }
  $script:serverStartAttempted = $true
  if (Test-Path $serverScript) {
    try {
      Start-Process -FilePath "node" -ArgumentList "`"$serverScript`"" -WorkingDirectory $rootDir -WindowStyle Hidden | Out-Null
    } catch {}
  }
}

function Request-SnapshotNow {
  if ($null -ne $script:pendingTask -and -not $script:pendingTask.IsCompleted) {
    return
  }
  $ctrlHud.SyncText.Text = $UI.syncing
  $script:lastFetchTime = [DateTime]::Now
  $script:pendingTask = $httpClient.GetStringAsync($apiUrl)
}

# Dragging & Click vs Hover Logic on Ball / Taskbar Window (Pure WPF DIPs)
$script:isDragging = $false
$script:dragStartLocal = New-Object System.Windows.Point(0, 0)
$script:dragStartDip = New-Object System.Windows.Point(0, 0)
$script:didMoveDuringDrag = $false
$script:hoverStartMs = 0
$script:leaveStartMs = 0

$ctrlBall.BallRoot.Add_MouseLeftButtonDown({
  param($sender, $e)
  $script:isDragging = $true
  $script:didMoveDuringDrag = $false
  $pos = $e.GetPosition($ballWin)
  $script:dragStartLocal = $pos
  $script:dragStartDip = New-Object System.Windows.Point(($ballWin.Left + $pos.X), ($ballWin.Top + $pos.Y))
  $ctrlBall.BallRoot.CaptureMouse() | Out-Null
})

$ctrlBall.BallRoot.Add_MouseMove({
  param($sender, $e)
  if (-not $script:isDragging) { return }
  $pos = $e.GetPosition($ballWin)
  $currDipX = $ballWin.Left + $pos.X
  $currDipY = $ballWin.Top + $pos.Y
  $dx = $currDipX - $script:dragStartDip.X
  $dy = $currDipY - $script:dragStartDip.Y

  if ([Math]::Abs($dx) -gt 4 -or [Math]::Abs($dy) -gt 4) {
    $script:didMoveDuringDrag = $true
  }
  if (-not $script:didMoveDuringDrag) { return }

  $wa = [System.Windows.SystemParameters]::WorkArea
  $screenW = [System.Windows.SystemParameters]::PrimaryScreenWidth

  if ($state.dockMode -eq 'taskbar') {
    # If pulled well above the taskbar (>38px above WorkArea.Bottom), auto-undock to Floating Ball mode
    if ($currDipY -lt ($wa.Bottom - 38)) {
      $state.dockMode = 'float'
      $state.left = [Math]::Max($wa.Left + 8, [Math]::Min($currDipX - 107, $wa.Right - 222))
      $state.top = [Math]::Max($wa.Top + 8, [Math]::Min($currDipY - 35, $wa.Bottom - 74))
      Apply-DockMode
      $script:dragStartLocal = New-Object System.Windows.Point(107, 35)
      return
    }

    # Otherwise slide smoothly left/right along the taskbar
    $newLeft = $currDipX - $script:dragStartLocal.X
    $newLeft = [Math]::Max(4, [Math]::Min($newLeft, $screenW - $ballWin.Width - 4))
    $ballWin.Left = $newLeft
    $ballWin.Top = Get-TaskbarTop
    $state.taskbarLeft = $newLeft
    if ($hudWin.Visibility -eq [System.Windows.Visibility]::Visible) {
      Update-HudPosition
    }
  } else {
    # In Float mode: if dragged down into the bottom taskbar strip, auto-dock into Taskbar Bar mode
    if ($currDipY -ge ($wa.Bottom - 10)) {
      $state.dockMode = 'taskbar'
      $state.taskbarLeft = [Math]::Max(4, [Math]::Min($currDipX - 203, $screenW - 410))
      Apply-DockMode
      $script:dragStartLocal = New-Object System.Windows.Point(203, 22)
      return
    }

    $newLeft = $currDipX - $script:dragStartLocal.X
    $newTop = $currDipY - $script:dragStartLocal.Y

    # Soft snap to screen edges within 14px
    if ([Math]::Abs($newLeft - $wa.Left) -lt 14) { $newLeft = $wa.Left + 4 }
    if ([Math]::Abs(($newLeft + $ballWin.Width) - $wa.Right) -lt 14) { $newLeft = $wa.Right - $ballWin.Width - 4 }
    if ([Math]::Abs($newTop - $wa.Top) -lt 14) { $newTop = $wa.Top + 4 }
    if ([Math]::Abs(($newTop + $ballWin.Height) - $wa.Bottom) -lt 14) { $newTop = $wa.Bottom - $ballWin.Height - 4 }

    $ballWin.Left = $newLeft
    $ballWin.Top = $newTop
    $state.left = $newLeft
    $state.top = $newTop
    if ($hudWin.Visibility -eq [System.Windows.Visibility]::Visible) {
      Update-HudPosition
    }
  }
})

$ctrlBall.BallRoot.Add_MouseLeftButtonUp({
  param($sender, $e)
  if ($script:isDragging) {
    $script:isDragging = $false
    $ctrlBall.BallRoot.ReleaseMouseCapture()
    if ($script:didMoveDuringDrag) {
      if ($state.dockMode -eq 'taskbar') {
        $state.taskbarLeft = $ballWin.Left
      } else {
        $state.left = $ballWin.Left
        $state.top = $ballWin.Top
      }
      Save-WidgetState
    } else {
      # Single click toggles Pinned Expanded HUD
      if ($hudWin.Visibility -eq [System.Windows.Visibility]::Visible -and $state.pinned) {
        $state.pinned = $false
        Update-ButtonsState
        Save-WidgetState
        Hide-HudPanel
      } else {
        $state.pinned = $true
        Update-ButtonsState
        Save-WidgetState
        Show-HudPanel
      }
    }
  }
})

# Allow dragging the HUD header bar too
$ctrlHud.HudHeaderBar.Add_MouseLeftButtonDown({
  param($sender, $e)
  if ($e.ClickCount -eq 1) {
    $hudWin.DragMove()
    if ($state.dockMode -eq 'taskbar') {
      $screenW = [System.Windows.SystemParameters]::PrimaryScreenWidth
      $ballWin.Left = [Math]::Max(4, [Math]::Min($hudWin.Left, $screenW - $ballWin.Width - 4))
      $ballWin.Top = Get-TaskbarTop
      $state.taskbarLeft = $ballWin.Left
    } else {
      $ballWin.Left = [Math]::Max(8, $hudWin.Left)
      $ballWin.Top = [Math]::Max(8, $hudWin.Top - $ballWin.Height + 6)
      $state.left = $ballWin.Left
      $state.top = $ballWin.Top
    }
    Save-WidgetState
  }
})

function Toggle-DockMode {
  if ($state.dockMode -eq 'taskbar') {
    $state.dockMode = 'float'
  } else {
    $state.dockMode = 'taskbar'
  }
  Apply-DockMode
  Update-ContextMenuLabels
  Save-WidgetState
}

# HUD Toolbar Button Handlers
$ctrlHud.BtnDockToggle.Add_Click({
  Toggle-DockMode
})

$ctrlHud.BtnCloseHud.Add_Click({
  $state.pinned = $false
  Update-ButtonsState
  Save-WidgetState
  Hide-HudPanel
})

$ctrlHud.BtnModeToggle.Add_Click({
  $state.showRemaining = -not $state.showRemaining
  Update-ButtonsState
  Save-WidgetState
  Render-Snapshot $script:lastSnapshot
})

$ctrlHud.BtnPinToggle.Add_Click({
  $state.pinned = -not $state.pinned
  Update-ButtonsState
  Save-WidgetState
})

$ctrlHud.BtnThemeToggle.Add_Click({
  $state.theme = if ($state.theme -eq 'dark') { 'light' } else { 'dark' }
  Apply-Theme
  Save-WidgetState
  Render-Snapshot $script:lastSnapshot
})

$ctrlHud.BtnRefreshNow.Add_Click({
  Request-SnapshotNow
})

$ctrlHud.BtnOpenWeb.Add_Click({
  Start-Process $webUrl | Out-Null
})

$ctrlHud.BtnOpacity.Add_Click({
  $state.opacityIndex = ($state.opacityIndex + 1) % $opacityLevels.Count
  Update-ButtonsState
  Save-WidgetState
})

# Create System Tray Icon (NotifyIcon) using Voxel Orb Icon
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$customIcoPath = Join-Path (Join-Path $rootDir 'public') 'voxel-orb.ico'
if (Test-Path $customIcoPath) {
  $notifyIcon.Icon = New-Object System.Drawing.Icon($customIcoPath)
  try {
    $icoUri = New-Object System.Uri($customIcoPath, [System.UriKind]::Absolute)
    $ballWin.Icon = [System.Windows.Media.Imaging.BitmapFrame]::Create($icoUri)
    $hudWin.Icon = [System.Windows.Media.Imaging.BitmapFrame]::Create($icoUri)
  } catch {}
} else {
  $bmp = New-Object System.Drawing.Bitmap(16, 16)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 15, 23, 42))), 1, 1, 14, 14)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 133, 94))), 2, 2, 5, 12)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 79, 156, 249))), 9, 2, 5, 12)
  $g.Dispose()
  $notifyIcon.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$notifyIcon.Text = $UI.trayTooltip
$notifyIcon.Visible = $true

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
$miDockToggle = $contextMenu.Items.Add($UI.trayDockFloat)
$miToggleHud = $contextMenu.Items.Add($UI.trayToggleHud)
$miOpenWeb = $contextMenu.Items.Add($UI.trayOpenWeb)
$miRefresh = $contextMenu.Items.Add($UI.trayRefresh)
$miTheme = $contextMenu.Items.Add($UI.trayTheme)
$contextMenu.Items.Add("-") | Out-Null
$miExit = $contextMenu.Items.Add($UI.trayExit)

function Update-ContextMenuLabels {
  if ($state.dockMode -eq 'taskbar') {
    $miDockToggle.Text = $UI.trayDockFloat
  } else {
    $miDockToggle.Text = $UI.trayDockTaskbar
  }
}

$miDockToggle.Add_Click({
  Toggle-DockMode
})

$miToggleHud.Add_Click({
  if ($hudWin.Visibility -eq [System.Windows.Visibility]::Visible) {
    $state.pinned = $false
    Update-ButtonsState
    Hide-HudPanel
  } else {
    $state.pinned = $true
    Update-ButtonsState
    Show-HudPanel
  }
})

$miOpenWeb.Add_Click({ Start-Process $webUrl | Out-Null })
$miRefresh.Add_Click({ Request-SnapshotNow })
$miTheme.Add_Click({
  $state.theme = if ($state.theme -eq 'dark') { 'light' } else { 'dark' }
  Apply-Theme
  Save-WidgetState
  Render-Snapshot $script:lastSnapshot
})

function Stop-FloatingBall {
  $timer.Stop()
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  try { $hudWin.Close() } catch {}
  try { $ballWin.Close() } catch {}
  try { $httpClient.Dispose() } catch {}
  try { $mutex.ReleaseMutex() } catch {}
  [System.Windows.Threading.Dispatcher]::ExitAllFrames()
  [Environment]::Exit(0)
}

$miExit.Add_Click({ Stop-FloatingBall })
$ctrlHud.BtnExitApp.Add_Click({ Stop-FloatingBall })
$ballWin.ContextMenu = $null
$ctrlBall.BallRoot.Add_MouseRightButtonUp({
  Update-ContextMenuLabels
  $pos = [System.Windows.Forms.Control]::MousePosition
  $contextMenu.Show($pos.X, $pos.Y)
})

$notifyIcon.ContextMenuStrip = $contextMenu
$notifyIcon.Add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    if ($hudWin.Visibility -eq [System.Windows.Visibility]::Visible) {
      $state.pinned = $false
      Update-ButtonsState
      Hide-HudPanel
    } else {
      $state.pinned = $true
      Update-ButtonsState
      Show-HudPanel
    }
  }
})

$script:ballHwnd = [IntPtr]::Zero
$script:hudHwnd = [IntPtr]::Zero

$ballWin.Add_SourceInitialized({
  $script:ballHwnd = (New-Object System.Windows.Interop.WindowInteropHelper($ballWin)).Handle
  [Win32WindowHelper]::MakeToolWindow($script:ballHwnd)
  [Win32WindowHelper]::KeepOnTop($script:ballHwnd)
})

$hudWin.Add_SourceInitialized({
  $script:hudHwnd = (New-Object System.Windows.Interop.WindowInteropHelper($hudWin)).Handle
  [Win32WindowHelper]::MakeToolWindow($script:hudHwnd)
  [Win32WindowHelper]::KeepOnTop($script:hudHwnd)
})

# Main UI Tick Timer (150ms interval for smooth hover detection + z-order above taskbar + async HTTP check + 15s polling)
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(150)

$timer.Add_Tick({
  # 0. Keep Taskbar Bar / Floating Ball above Windows 11 Taskbar (Shell_TrayWnd) without stealing focus
  if ($script:ballHwnd -ne [IntPtr]::Zero) {
    [Win32WindowHelper]::KeepOnTop($script:ballHwnd)
  }
  if ($hudWin.Visibility -eq [System.Windows.Visibility]::Visible -and $script:hudHwnd -ne [IntPtr]::Zero) {
    [Win32WindowHelper]::KeepOnTop($script:hudHwnd)
  }

  # 1. Check single-instance wake signal
  if ($wakeEvent.WaitOne(0)) {
    $ballWin.Show()
    $state.pinned = $true
    Update-ButtonsState
    Show-HudPanel
    Request-SnapshotNow
  }

  # 2. Check Hover Expand / Auto Collapse
  if (-not $script:isDragging) {
    $overBall = $ballWin.IsMouseOver
    $overHud = ($hudWin.Visibility -eq [System.Windows.Visibility]::Visible) -and $hudWin.IsMouseOver

    if ($overBall -or $overHud) {
      $script:leaveStartMs = 0
      if ($hudWin.Visibility -ne [System.Windows.Visibility]::Visible) {
        if ($script:hoverStartMs -eq 0) {
          $script:hoverStartMs = [Environment]::TickCount
        } elseif (([Environment]::TickCount - $script:hoverStartMs) -ge 200) {
          Show-HudPanel
        }
      }
    } else {
      $script:hoverStartMs = 0
      if ($hudWin.Visibility -eq [System.Windows.Visibility]::Visible -and -not $state.pinned) {
        if ($script:leaveStartMs -eq 0) {
          $script:leaveStartMs = [Environment]::TickCount
        } elseif (([Environment]::TickCount - $script:leaveStartMs) -ge 380) {
          Hide-HudPanel
        }
      }
    }
  }

  # 3. Check pending async HTTP task
  if ($null -ne $script:pendingTask -and $script:pendingTask.IsCompleted) {
    $task = $script:pendingTask
    $script:pendingTask = $null
    if ($task.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) {
      try {
        $jsonStr = $task.Result
        $snapObj = $jsonStr | ConvertFrom-Json
        Render-Snapshot $snapObj
      } catch {
        $ctrlHud.SyncText.Text = "PARSE ERR"
        $ctrlHud.SyncText.Foreground = New-Brush "#F59E0B"
      }
    } else {
      $ctrlHud.SyncText.Text = $UI.offline
      $ctrlHud.SyncText.Foreground = New-Brush "#F59E0B"
      $ctrlBall.StatusDot.Fill = New-Brush "#F59E0B"
      $ctrlBall.TbStatusDot.Fill = New-Brush "#F59E0B"
      Start-BackendServerIfNeeded
    }
  }

  # 4. Trigger periodic poll every 15 seconds
  $elapsedSec = ([DateTime]::Now - $script:lastFetchTime).TotalSeconds
  if ($null -eq $script:pendingTask -and $elapsedSec -ge 15.0) {
    Request-SnapshotNow
  }
})

# Initialize UI state & start
Apply-Theme
Apply-DockMode
Update-ContextMenuLabels
Save-WidgetState
$ballWin.Show()
$ballWin.Activate() | Out-Null
if ($state.pinned) {
  Show-HudPanel
}
Request-SnapshotNow
$timer.Start()

[System.Windows.Threading.Dispatcher]::Run()

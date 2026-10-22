using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("Flo Cafe Uninstaller")]
[assembly: AssemblyProduct("Flo Cafe")]

internal static class Program
{
    private const string ScriptResource = "uninstall-windows.ps1";

    [STAThread]
    private static int Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string locale = Strings.Resolve(Environment.GetEnvironmentVariable("FLOCAFE_UNINSTALL_LANG"), CultureInfo.CurrentUICulture);
        string[] text = Strings.For(locale);
        MessageBoxOptions options = Strings.IsRtl(locale)
            ? MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign
            : 0;

        DialogResult answer = MessageBox.Show(text[Strings.Warning], text[Strings.Title],
            MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2, options);
        if (answer != DialogResult.Yes) return 2;

        int exitCode = RunUninstallScript();
        if (exitCode == 0)
        {
            MessageBox.Show(text[Strings.Done], text[Strings.Title], MessageBoxButtons.OK, MessageBoxIcon.Information,
                MessageBoxDefaultButton.Button1, options);
            return 0;
        }

        MessageBox.Show(text[Strings.Incomplete], text[Strings.Title], MessageBoxButtons.OK, MessageBoxIcon.Error,
            MessageBoxDefaultButton.Button1, options);
        return 1;
    }

    private static int RunUninstallScript()
    {
        string workDir = Path.Combine(Path.GetTempPath(), "FloCafe-uninstall-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(workDir);
            string scriptPath = Path.Combine(workDir, ScriptResource);
            using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream(ScriptResource))
            {
                if (source == null) return -1;
                using (FileStream target = File.Create(scriptPath)) source.CopyTo(target);
            }

            string powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            ProcessStartInfo start = new ProcessStartInfo(powershell,
                "-NoProfile -ExecutionPolicy Bypass -File \"" + scriptPath + "\" -PurgeData");
            start.UseShellExecute = false;
            using (Process process = Process.Start(start))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception)
        {
            return -1;
        }
        finally
        {
            try { Directory.Delete(workDir, true); } catch (Exception) { }
        }
    }
}

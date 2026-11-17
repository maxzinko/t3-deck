// T3 Deck foreground watcher. Prints one JSON line each time another window comes to
// the front (and once at start), so the plugin can pick a Stream Deck profile for it:
//   {"pid":1234,"exe":"chrome.exe","path":"C:\\...\\chrome.exe","cls":"Chrome_WidgetWin_1","title":"...","min":false}
// Reads commands on stdin, one per line:
//   keys ctrl+shift+]     press a key combination (SendInput)
//   now                   print the current foreground window again
//   focus T3 Code         bring the first window of a program whose file name starts with this to the front
// Exits when stdin closes, so it never outlives the plugin.
// Build: csc /target:winexe /out:fgwatch.exe fgwatch.cs   (csc ships with .NET Framework 4)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class FgWatch
{
	delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);

	[DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
	[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder s, int n);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder s, int n);
	[DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
	[DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr hwnd, uint min, uint max);
	[DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
	[DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
	[DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
	[DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
	[DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
	[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int n);
	delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr l);
	[DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc proc, IntPtr l);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
	[DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
	[DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
	[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
	[DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
	[DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
	[DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);

	[StructLayout(LayoutKind.Sequential)]
	struct MSG { public IntPtr hwnd; public uint message; public IntPtr w; public IntPtr l; public uint time; public int x; public int y; }

	[StructLayout(LayoutKind.Sequential)]
	struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
	[StructLayout(LayoutKind.Sequential)]
	struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
	[StructLayout(LayoutKind.Explicit)]
	struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
	[StructLayout(LayoutKind.Sequential)]
	struct INPUT { public uint type; public INPUTUNION u; }

	const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
	const uint EVENT_SYSTEM_MINIMIZEEND = 0x0017;
	const uint EVENT_SYSTEM_MINIMIZESTART = 0x0016;
	const uint WINEVENT_OUTOFCONTEXT = 0;
	const uint WM_APP = 0x8000;

	static WinEventProc proc; // kept alive for the hook
	static uint mainThread;
	static readonly object outLock = new object();
	static string last = "";
	static System.IO.StreamWriter stdout;

	static string Esc(string s)
	{
		var b = new StringBuilder();
		foreach (char c in s ?? "")
		{
			if (c == '"' || c == '\\') b.Append('\\').Append(c);
			else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
			else b.Append(c);
		}
		return b.ToString();
	}

	static string ProcPath(uint pid)
	{
		IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
		if (h == IntPtr.Zero) return "";
		try
		{
			var s = new StringBuilder(1024);
			int n = s.Capacity;
			return QueryFullProcessImageName(h, 0, s, ref n) ? s.ToString() : "";
		}
		finally { CloseHandle(h); }
	}

	static void Report(bool force)
	{
		IntPtr hwnd = GetForegroundWindow();
		uint pid = 0;
		if (hwnd != IntPtr.Zero) GetWindowThreadProcessId(hwnd, out pid);
		var title = new StringBuilder(512);
		var cls = new StringBuilder(256);
		if (hwnd != IntPtr.Zero)
		{
			GetWindowText(hwnd, title, title.Capacity);
			GetClassName(hwnd, cls, cls.Capacity);
		}
		string path = pid != 0 ? ProcPath(pid) : "";
		string exe = path.Length > 0 ? System.IO.Path.GetFileName(path) : "";
		bool min = hwnd != IntPtr.Zero && IsIconic(hwnd);
		string line = "{\"pid\":" + pid + ",\"exe\":\"" + Esc(exe) + "\",\"path\":\"" + Esc(path) + "\",\"cls\":\"" + Esc(cls.ToString()) +
			"\",\"title\":\"" + Esc(title.ToString()) + "\",\"min\":" + (min ? "true" : "false") + "}";
		lock (outLock)
		{
			if (!force && line == last) return;
			last = line;
			stdout.WriteLine(line);
			stdout.Flush();
		}
	}

	static readonly Dictionary<string, ushort> Named = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
	{
		{"ctrl",0x11},{"control",0x11},{"shift",0x10},{"alt",0x12},{"win",0x5B},
		{"enter",0x0D},{"esc",0x1B},{"escape",0x1B},{"tab",0x09},{"space",0x20},{"backspace",0x08},{"delete",0x2E},
		{"up",0x26},{"down",0x28},{"left",0x25},{"right",0x27},{"pageup",0x21},{"pagedown",0x22},{"home",0x24},{"end",0x23},
		{"[",0xDB},{"]",0xDD},{";",0xBA},{"'",0xDE},{",",0xBC},{".",0xBE},{"/",0xBF},{"\\",0xDC},{"-",0xBD},{"=",0xBB},{"`",0xC0},
	};

	static ushort Vk(string k)
	{
		ushort v;
		if (Named.TryGetValue(k, out v)) return v;
		if (k.Length == 1 && char.IsLetterOrDigit(k[0])) return (ushort)char.ToUpperInvariant(k[0]);
		if (k.Length >= 2 && (k[0] == 'f' || k[0] == 'F'))
		{
			int n;
			if (int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x70 + n - 1);
		}
		return 0;
	}

	static INPUT Key(ushort vk, bool up)
	{
		var i = new INPUT { type = 1 };
		i.u.ki.vk = vk;
		i.u.ki.scan = (ushort)MapVirtualKey(vk, 0);
		uint flags = up ? 2u : 0u; // KEYEVENTF_KEYUP
		if (vk >= 0x21 && vk <= 0x2E) flags |= 1; // extended keys (arrows, page up/down, home, end, delete)
		i.u.ki.flags = flags;
		return i;
	}

	static void SendKeys(string combo)
	{
		// "ctrl+shift+]" -> press in order, release in reverse. A lone "+" key is written "plus".
		var parts = combo.Replace("++", "+plus").Split('+');
		var vks = new List<ushort>();
		foreach (var p in parts)
		{
			var k = p.Trim();
			if (k.Length == 0) continue;
			ushort vk = k.Equals("plus", StringComparison.OrdinalIgnoreCase) ? (ushort)0xBB : Vk(k);
			if (vk == 0) return; // unknown key name: send nothing
			vks.Add(vk);
		}
		var inputs = new List<INPUT>();
		foreach (var vk in vks) inputs.Add(Key(vk, false));
		for (int i = vks.Count - 1; i >= 0; i--) inputs.Add(Key(vks[i], true));
		SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
	}

	// Brings the main window of the first program whose file name starts with `prefix` to
	// the front. Windows only lets the foreground program do that, so a lone Alt press
	// first unlocks it (the usual way tools such as launchers do it).
	static void Focus(string prefix)
	{
		IntPtr found = IntPtr.Zero;
		EnumWindows((hwnd, l) =>
		{
			if (!IsWindowVisible(hwnd) || GetWindow(hwnd, 4) != IntPtr.Zero) return true; // 4 = GW_OWNER: skip owned popups
			var title = new StringBuilder(256);
			if (GetWindowText(hwnd, title, title.Capacity) == 0) return true;
			uint pid;
			GetWindowThreadProcessId(hwnd, out pid);
			string exe = System.IO.Path.GetFileName(ProcPath(pid));
			if (!exe.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true;
			found = hwnd;
			return false;
		}, IntPtr.Zero);
		if (found == IntPtr.Zero) return;
		if (IsIconic(found)) ShowWindow(found, 9); // SW_RESTORE
		if (GetForegroundWindow() == found) return;
		SendInput(2, new[] { Key(0x12, false), Key(0x12, true) }, Marshal.SizeOf(typeof(INPUT)));
		BringWindowToTop(found);
		SetForegroundWindow(found);
	}

	static void ReadStdin()
	{
		try
		{
			string line;
			var stdin = new System.IO.StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
			while ((line = stdin.ReadLine()) != null)
			{
				line = line.Trim();
				if (line == "now") Report(true);
				else if (line.StartsWith("keys ")) SendKeys(line.Substring(5).Trim());
				else if (line.StartsWith("focus ")) Focus(line.Substring(6).Trim());
			}
		}
		catch { }
		PostThreadMessage(mainThread, WM_APP, IntPtr.Zero, IntPtr.Zero); // stdin closed: quit
	}

	static int Main()
	{
		// No console in a winexe: write UTF-8 straight to the inherited pipe.
		stdout = new System.IO.StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
		mainThread = GetCurrentThreadId();
		proc = (hook, ev, hwnd, obj, child, thread, time) =>
		{
			if (obj != 0) return; // OBJID_WINDOW only
			if (ev == EVENT_SYSTEM_MINIMIZESTART)
			{
				// The next window may take a moment to come to the front.
				ThreadPool.QueueUserWorkItem(_ => { Thread.Sleep(200); Report(false); });
				return;
			}
			Report(false);
		};
		SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, proc, 0, 0, WINEVENT_OUTOFCONTEXT);
		SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, IntPtr.Zero, proc, 0, 0, WINEVENT_OUTOFCONTEXT);
		var reader = new Thread(ReadStdin) { IsBackground = true };
		reader.Start();
		Report(true);
		MSG m;
		while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0)
		{
			if (m.message == WM_APP) break;
			TranslateMessage(ref m);
			DispatchMessage(ref m);
		}
		return 0;
	}
}

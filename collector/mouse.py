import ctypes
import sys
from ctypes import wintypes

# Windows low-level mouse hook. No input is injected or modified.
WH_MOUSE_LL = 14
WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_RBUTTONDOWN = 0x0204
WM_RBUTTONUP = 0x0205
WM_MBUTTONDOWN = 0x0207
WM_MBUTTONUP = 0x0208
WM_XBUTTONDOWN = 0x020B
WM_XBUTTONUP = 0x020C

# 64-bit correct Win32 signatures. HMODULE/HHOOK/LRESULT are pointer-sized on
# x64; without these, ctypes' default 32-bit c_int restype truncates the value
# returned by GetModuleHandleW and SetWindowsHookExW fails with WinError 126
# (ERROR_MOD_NOT_FOUND).
LRESULT = ctypes.c_ssize_t
HOOKPROC = ctypes.WINFUNCTYPE(LRESULT, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)
user32 = ctypes.WinDLL('user32', use_last_error=True)
user32.SetWindowsHookExW.argtypes = (ctypes.c_int, HOOKPROC, wintypes.HMODULE, wintypes.DWORD)
user32.SetWindowsHookExW.restype = wintypes.HHOOK
user32.CallNextHookEx.argtypes = (wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)
user32.CallNextHookEx.restype = LRESULT
user32.UnhookWindowsHookEx.argtypes = (wintypes.HHOOK,)
user32.UnhookWindowsHookEx.restype = wintypes.BOOL
user32.GetMessageW.argtypes = (ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT)
user32.GetMessageW.restype = ctypes.c_long
user32.TranslateMessage.argtypes = (ctypes.POINTER(wintypes.MSG),)
user32.DispatchMessageW.argtypes = (ctypes.POINTER(wintypes.MSG),)
user32.DispatchMessageW.restype = LRESULT

class POINT(ctypes.Structure):
    _fields_ = [('x', wintypes.LONG), ('y', wintypes.LONG)]

class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [('pt', POINT), ('mouseData', wintypes.DWORD), ('flags', wintypes.DWORD), ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.c_size_t)]

EVENTS = {
    WM_LBUTTONDOWN: ('left', 'down'), WM_LBUTTONUP: ('left', 'up'),
    WM_RBUTTONDOWN: ('right', 'down'), WM_RBUTTONUP: ('right', 'up'),
    WM_MBUTTONDOWN: ('middle', 'down'), WM_MBUTTONUP: ('middle', 'up'),
    WM_XBUTTONDOWN: ('x', 'down'), WM_XBUTTONUP: ('x', 'up'),
}

class MouseHook:
    def __init__(self, record): self.record = record; self.hook = None; self.callback = None; self.last = None

    def run(self):
        if sys.platform != 'win32': return

        def proc(nCode, wParam, lParam):
            if nCode >= 0:
                info = ctypes.cast(lParam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
                x, y = int(info.pt.x), int(info.pt.y)
                if wParam == WM_MOUSEMOVE:
                    if self.last is not None:
                        dx, dy = x - self.last[0], y - self.last[1]
                        if dx or dy:
                            self.record('mouse', 'mouse_move', {'dx': dx, 'dy': dy, 'x': x, 'y': y})
                    self.last = (x, y)
                elif wParam in EVENTS:
                    button, state = EVENTS[wParam]
                    if button == 'x':
                        button = 'x1' if ((info.mouseData >> 16) & 0xFFFF) == 1 else 'x2'
                    self.record('mouse', 'mouse_button', {'button': button, 'state': state, 'x': x, 'y': y})
            return user32.CallNextHookEx(self.hook, nCode, wParam, lParam)

        self.callback = HOOKPROC(proc)
        # For low-level hooks the callback lives in the current process and
        # dwThreadId=0, so hMod=NULL is the documented-correct value.
        self.hook = user32.SetWindowsHookExW(WH_MOUSE_LL, self.callback, None, 0)
        if not self.hook:
            raise ctypes.WinError(ctypes.get_last_error())
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg)); user32.DispatchMessageW(ctypes.byref(msg))
        user32.UnhookWindowsHookEx(self.hook)

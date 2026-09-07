import ctypes, sys
from ctypes import wintypes

WH_KEYBOARD_LL = 13
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_SYSKEYDOWN = 0x0104
WM_SYSKEYUP = 0x0105

# 64-bit correct Win32 signatures; see collector/mouse.py for the rationale.
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

class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [('vkCode', wintypes.DWORD), ('scanCode', wintypes.DWORD), ('flags', wintypes.DWORD), ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.c_size_t)]

VK_NAMES = {
    0x08:'backspace',0x09:'tab',0x0D:'enter',0x10:'shift',0x11:'ctrl',0x12:'alt',0x1B:'escape',
    0x20:'space',0x25:'left',0x26:'up',0x27:'right',0x28:'down',0x2D:'insert',0x2E:'delete',
}

def name_for_vk(vk):
    if 0x41 <= vk <= 0x5A: return chr(vk).lower()
    if 0x30 <= vk <= 0x39: return chr(vk)
    if 0x70 <= vk <= 0x7B: return f'f{vk-0x6F}'
    return VK_NAMES.get(vk, f'vk_{vk}')

class KeyboardHook:
    def __init__(self, record): self.record=record; self.hook=None; self.callback=None

    def run(self):
        if sys.platform != 'win32': return

        def proc(nCode, wParam, lParam):
            if nCode >= 0 and wParam in (WM_KEYDOWN,WM_SYSKEYDOWN,WM_KEYUP,WM_SYSKEYUP):
                info = ctypes.cast(lParam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
                state = 'down' if wParam in (WM_KEYDOWN, WM_SYSKEYDOWN) else 'up'
                self.record('keyboard','key_'+state,{'key':name_for_vk(int(info.vkCode)),'vk':int(info.vkCode),'scanCode':int(info.scanCode)})
            return user32.CallNextHookEx(self.hook, nCode, wParam, lParam)

        self.callback = HOOKPROC(proc)
        self.hook = user32.SetWindowsHookExW(WH_KEYBOARD_LL, self.callback, None, 0)
        if not self.hook:
            raise ctypes.WinError(ctypes.get_last_error())
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg)); user32.DispatchMessageW(ctypes.byref(msg))
        user32.UnhookWindowsHookEx(self.hook)

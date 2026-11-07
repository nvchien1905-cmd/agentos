#!/usr/bin/env python3
# Giới hạn cổng TCP mà tiến trình (và mọi tiến trình con của nó) được KẾT NỐI tới, bằng Landlock của nhân Linux (cần Linux 6.7+, Debian 13 có).
# Dùng cho AI của ID thường: trong hộp cô lập chỉ cho kết nối ra cổng web (80/443/53) cùng vài cổng nội bộ được liệt kê (cổng duyệt, Chrome RIÊNG của ID đó),
# nên không với tới được Chrome đã đăng nhập của chủ máy (cổng điều khiển ngẫu nhiên trên 127.0.0.1) hay dịch vụ nội bộ khác.
#   landlock-net.py --check                      thoát 0 nếu nhân hỗ trợ (ABI >= 4)
#   landlock-net.py --ports 80,443,38211 -- lệnh args...
import ctypes
import os
import sys

SYS_CREATE, SYS_ADD, SYS_RESTRICT = 444, 445, 446      # landlock_create_ruleset / add_rule / restrict_self (cùng số trên mọi kiến trúc)
CONNECT_TCP = 1 << 1
RULE_NET_PORT = 2
PR_SET_NO_NEW_PRIVS = 38
libc = ctypes.CDLL(None, use_errno=True)


def abi():
    v = libc.syscall(SYS_CREATE, None, 0, 1)            # LANDLOCK_CREATE_RULESET_VERSION
    return v if v > 0 else 0


def die(msg):
    sys.stderr.write('landlock-net: ' + msg + '\n')
    sys.exit(126)


def main(argv):
    if argv and argv[0] == '--check':
        return 0 if abi() >= 4 else 1
    if len(argv) < 4 or argv[0] != '--ports' or '--' not in argv:
        die('cách dùng: landlock-net.py --ports 80,443 -- lệnh args...')
    cut = argv.index('--')
    try:
        ports = sorted({int(p) for p in argv[1].split(',') if p.strip()})
    except ValueError:
        die('danh sách cổng không hợp lệ')
    cmd = argv[cut + 1:]
    if not cmd:
        die('thiếu lệnh cần chạy')
    if abi() < 4:
        die('nhân Linux không hỗ trợ giới hạn mạng bằng Landlock (cần ABI 4+)')
    attr = (ctypes.c_uint64 * 2)(0, CONNECT_TCP)         # handled_access_fs = 0, handled_access_net = CONNECT_TCP
    fd = libc.syscall(SYS_CREATE, ctypes.byref(attr), 16, 0)
    if fd < 0:
        die('không tạo được bộ luật Landlock (errno %d)' % ctypes.get_errno())
    for p in ports:
        rule = (ctypes.c_uint64 * 2)(CONNECT_TCP, p)     # struct landlock_net_port_attr { u64 allowed_access; u64 port; }
        if libc.syscall(SYS_ADD, fd, RULE_NET_PORT, ctypes.byref(rule), 0) != 0:
            die('không thêm được cổng %d (errno %d)' % (p, ctypes.get_errno()))
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        die('không đặt được no_new_privs')
    if libc.syscall(SYS_RESTRICT, fd, 0) != 0:
        die('không áp dụng được bộ luật (errno %d)' % ctypes.get_errno())
    os.close(fd)
    try:
        os.execvp(cmd[0], cmd)
    except OSError as e:
        die('không chạy được ' + cmd[0] + ': ' + str(e))


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

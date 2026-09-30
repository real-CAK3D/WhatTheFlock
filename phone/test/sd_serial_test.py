"""Exercise the firmware's microSD commands over USB serial from the PC.

Usage: python sd_serial_test.py COM7
Checks: boot/SD status, set_time, backup write (chunked, CRC) + read-back, log dump.
"""
import base64, json, sys, time, zlib

import serial

port = sys.argv[1] if len(sys.argv) > 1 else "COM7"
s = serial.Serial()
s.port, s.baudrate, s.timeout = port, 115200, 0.2
s.dtr, s.rts = True, False          # other DTR/RTS combos reset the S3
s.open()


def send(obj):
    s.write((json.dumps(obj, separators=(",", ":")) + "\n").encode())


partial = b""


def wait_for(event, timeout=5.0, collect=None):
    global partial
    end = time.time() + timeout
    while time.time() < end:
        chunk = s.readline()                 # one line, or a fragment on timeout
        partial += chunk
        if not partial.endswith(b"\n"):
            continue
        line, partial = partial, b""
        if True:
            line = line.decode(errors="replace").strip()
            if not line.startswith("{"):
                if line:
                    print("   |", line[:120])
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if collect is not None and ev.get("event") == collect:
                yield_list.append(ev)
            if ev.get("event") == event:
                return ev
    return None


def request(obj, event, tries=4, timeout=1.5, check=None):
    """Send a command and wait for its reply, resending if it goes unanswered."""
    for _ in range(tries):
        send(obj)
        ev = wait_for(event, timeout)
        if ev and (check is None or check(ev)):
            return ev
    return None


yield_list = []
time.sleep(1.5)
s.reset_input_buffer()

info = request({"cmd": "sd_info"}, "sd_info")
print("sd_info:", info)
if not info or not info.get("ok"):
    print("NO SD CARD MOUNTED — stopping here")
    sys.exit(1)

print("set_time:", request({"cmd": "set_time", "epoch": int(time.time())}, "time_ok"))

# Backup round trip with ~5 KB of pseudo-random JSON-ish data.
payload = json.dumps({"test": True, "ts": time.time(), "blob": base64.b64encode(bytes(range(256)) * 16).decode()}).encode()
assert request({"cmd": "sd_wopen"}, "sd_ack", check=lambda e: e["n"] == -1), "sd_wopen not acked"
t0 = time.time()
for i in range(0, len(payload), 600):
    n = i // 600
    ack = request({"cmd": "sd_w", "n": n, "d": base64.b64encode(payload[i:i + 600]).decode()}, "sd_ack", check=lambda e: e["n"] == n)
    assert ack, f"chunk {n} not acked"
print("write:", request({"cmd": "sd_wclose", "len": len(payload), "crc": "0x%08X" % (zlib.crc32(payload) & 0xFFFFFFFF)}, "sd_wok"),
      f"{len(payload)} bytes in {time.time() - t0:.2f}s")

back, off = b"", 0
while True:
    rd = request({"cmd": "sd_r", "off": off, "len": 600}, "sd_rd", check=lambda e: e["off"] == off)
    chunk = base64.b64decode(rd["d"])
    back += chunk
    off += len(chunk)
    if not chunk or off >= rd["size"]:
        break
print("read-back matches:", back == payload, len(back), "bytes")

yield_list.clear()
send({"cmd": "sd_dump", "from": 0, "max": 50})
end = wait_for("sd_end", 10, collect="sd_det")
print("dump:", end, "| lines received:", len(yield_list), "| sample:", yield_list[:1])

send({"cmd": "sd_info"})
print("sd_info after:", wait_for("sd_info"))
s.close()

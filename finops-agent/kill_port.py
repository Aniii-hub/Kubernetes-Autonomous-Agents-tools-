import os
import subprocess

try:
    output = subprocess.check_output("netstat -ano", shell=True).decode()
    pids = set()
    for line in output.strip().split("\n"):
        if "8585" in line and "LISTENING" in line:
            parts = [p for p in line.split(" ") if p]
            if len(parts) >= 5:
                pids.add(parts[-1].strip())
    for pid in pids:
        if pid != "0":
            print(f"Killing PID {pid}")
            os.system(f"taskkill /F /PID {pid}")
except Exception as e:
    print(f"Error: {e}")

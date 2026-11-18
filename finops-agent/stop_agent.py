import os
import sys

try:
    import psutil
    terminated = False
    for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
        try:
            cmd = proc.info['cmdline']
            if cmd and any('agent.py' in part for part in cmd):
                print(f"Found running agent process: PID {proc.info['pid']} - {cmd}")
                proc.terminate()
                terminated = True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    if not terminated:
        print("No running self-healing agent process found.")
except ImportError:
    # Fallback to taskkill or wmic
    print("psutil not available. Attempting taskkill using command line filters...")
    os.system('wmic process where "commandline like \'%agent.py%\'" get processid')
    # Kill python processes that might be running agent.py
    os.system('taskkill /f /fi "IMAGENAME eq python.exe"')

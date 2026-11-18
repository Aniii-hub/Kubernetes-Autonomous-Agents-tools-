from pathlib import Path
html_path = Path("server.py").parent / "dashboard.html"
print("html_path:", html_path)
print("exists:", html_path.exists())

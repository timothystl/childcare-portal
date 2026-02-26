#!/usr/bin/env python3
"""
Simple dev server for the childcare portal.
Run: python3 serve.py
"""
import http.server
import os

PORT = 3000
# Always serve from the directory this script lives in
os.chdir(os.path.dirname(os.path.abspath(__file__)))

handler = http.server.SimpleHTTPRequestHandler

with http.server.HTTPServer(("", PORT), handler) as httpd:
    print(f"Serving childcare portal at http://localhost:{PORT}")
    print("Press Ctrl+C to stop.")
    httpd.serve_forever()

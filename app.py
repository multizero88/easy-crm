import os
import sys

# Redirect stdout/stderr in windowed (noconsole) PyInstaller mode to prevent crashes
class NullWriter:
    def write(self, x):
        pass
    def flush(self):
        pass

if sys.stdout is None:
    sys.stdout = NullWriter()
if sys.stderr is None:
    sys.stderr = NullWriter()

import sqlite3
import hashlib
import socket
import webbrowser
import time
import json
import urllib.request
import urllib.parse
import threading
from threading import Timer, Thread
from flask import Flask, request, jsonify, render_template, session, g, has_request_context, make_response, send_file
import pymysql
import decimal
import datetime
import re

try:
    import psycopg2
    import psycopg2.extras
    import psycopg2.pool
except Exception:
    psycopg2 = None

import gzip

# Dedicated VPS PostgreSQL Configuration
SUPABASE_CONFIG = {
    "host": "89.124.92.53",
    "port": 5432,
    "dbname": "easy_crm",
    "user": "easy_crm_user",
    "password": "EasyCrm_2026_SecureDb!"
}

_supabase_pool = None
_supabase_pool_lock = threading.Lock()

def get_supabase_pool():
    global _supabase_pool
    if _supabase_pool is None and psycopg2 is not None:
        with _supabase_pool_lock:
            if _supabase_pool is None:
                try:
                    _supabase_pool = psycopg2.pool.ThreadedConnectionPool(
                        minconn=2,
                        maxconn=16,
                        host=SUPABASE_CONFIG['host'],
                        port=SUPABASE_CONFIG['port'],
                        dbname=SUPABASE_CONFIG['dbname'],
                        user=SUPABASE_CONFIG['user'],
                        password=SUPABASE_CONFIG['password'],
                        sslmode="prefer",
                        connect_timeout=5
                    )
                except Exception as e:
                    print(f"Failed to initialize Supabase Connection Pool: {e}")
    return _supabase_pool

# Catalog in-memory cache & version tracking for instant response times
_catalog_version = int(time.time() * 1000)
_catalog_lock = threading.Lock()
_catalog_cache = None          # Cached list of all product dicts
_catalog_barcode_map = {}      # Barcode string -> product dict
_catalog_id_map = {}           # Product ID int -> product dict

def invalidate_catalog_cache():
    global _catalog_cache, _catalog_barcode_map, _catalog_id_map, _catalog_version
    with _catalog_lock:
        _catalog_cache = None
        _catalog_barcode_map = {}
        _catalog_id_map = {}
        _catalog_version = int(time.time() * 1000)

def bump_catalog_version():
    invalidate_catalog_cache()

def get_catalog_version():
    return str(_catalog_version)

class PostgresRow:
    def __init__(self, cursor, row_tuple):
        self._keys = [desc[0] for desc in cursor.description]
        formatted = []
        for v in row_tuple:
            if isinstance(v, decimal.Decimal):
                # Format decimal to float or int for clean JSON and math
                f_val = float(v)
                formatted.append(int(f_val) if f_val.is_integer() else f_val)
            elif isinstance(v, (datetime.datetime, datetime.date)):
                formatted.append(v.strftime('%Y-%m-%d %H:%M:%S') if isinstance(v, datetime.datetime) else v.strftime('%Y-%m-%d'))
            else:
                formatted.append(v)
        self._row = tuple(formatted)
        
    def __getitem__(self, key):
        if isinstance(key, int):
            return self._row[key]
        else:
            try:
                idx = self._keys.index(key)
                return self._row[idx]
            except ValueError:
                raise KeyError(f"Column '{key}' not found in row. Available: {self._keys}")
                
    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default
            
    def __len__(self):
        return len(self._row)
        
    def keys(self):
        return self._keys
        
    def __iter__(self):
        return iter(self._keys)
        
    def __repr__(self):
        return str(dict(zip(self._keys, self._row)))

class PostgresCursorWrapper:
    def __init__(self, cursor):
        self.cursor = cursor
        self.lastrowid = None
        self.description = None
        self.rowcount = 0
        
    def execute(self, query, params=None):
        q = query
        # 1. Placeholders
        q = q.replace('?', '%s')
        
        # 2. Case-insensitive regex translations for SQLite date/time functions
        q = re.sub(r"DATETIME\s*\(\s*'now'\s*,\s*'localtime'\s*\)", "(NOW() AT TIME ZONE 'Asia/Tashkent')", q, flags=re.IGNORECASE)
        q = re.sub(r"DATETIME\s*\(\s*'now'\s*\)", "(NOW() AT TIME ZONE 'Asia/Tashkent')", q, flags=re.IGNORECASE)
        q = re.sub(r"DATE\s*\(\s*'now'\s*,\s*'localtime'\s*\)", "((NOW() AT TIME ZONE 'Asia/Tashkent')::date)", q, flags=re.IGNORECASE)
        q = re.sub(r"DATE\s*\(\s*'now'\s*\)", "((NOW() AT TIME ZONE 'Asia/Tashkent')::date)", q, flags=re.IGNORECASE)
        q = re.sub(r'\bIFNULL\b', 'COALESCE', q, flags=re.IGNORECASE)
        # Translation for SQLite instr(string, substring)
        q = re.sub(r'\binstr\s*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)\s*>\s*0', r'(STRPOS(\1, \2) > 0)', q, flags=re.IGNORECASE)
        q = re.sub(r'\binstr\s*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)', r'(STRPOS(\1, \2) > 0)', q, flags=re.IGNORECASE)
        
        # 3. Settings table upsert
        if re.search(r'INSERT\s+OR\s+REPLACE\s+INTO\s+settings', q, flags=re.IGNORECASE):
            q = re.sub(r'INSERT\s+OR\s+REPLACE\s+INTO\s+settings', 'INSERT INTO settings', q, flags=re.IGNORECASE)
            q = q.rstrip(';').strip()
            if 'ON CONFLICT' not in q.upper():
                q += ' ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
            
        # 4. Handle auto-generated IDs
        is_insert = q.strip().upper().startswith('INSERT INTO')
        if is_insert and 'RETURNING' not in q.upper() and 'INTO SETTINGS' not in q.upper():
            q = q.rstrip(';') + ' RETURNING id;'
            
        if params is not None:
            if not isinstance(params, (list, tuple)):
                params = (params,)
            self.cursor.execute(q, params)
        else:
            self.cursor.execute(q)
            
        self.description = self.cursor.description
        self.rowcount = self.cursor.rowcount
        
        if is_insert:
            try:
                res = self.cursor.fetchone()
                if res:
                    self.lastrowid = res[0]
            except Exception:
                pass

    def fetchone(self):
        r = self.cursor.fetchone()
        if r is None:
            return None
        return PostgresRow(self.cursor, r)
        
    def fetchall(self):
        rows = self.cursor.fetchall()
        return [PostgresRow(self.cursor, r) for r in rows]
        
    def close(self):
        try:
            self.cursor.close()
        except Exception:
            pass

    def __enter__(self):
        return self
        
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False

class PostgresConnectionWrapper:
    def __init__(self, config):
        self.config = config
        self.pool = get_supabase_pool()
        self.conn = None
        self.connect()
        
    def connect(self):
        if self.pool is not None:
            try:
                self.conn = self.pool.getconn()
                self.conn.autocommit = True
                return
            except Exception as e:
                print(f"Pool getconn error: {e}")
                
        self.conn = psycopg2.connect(
            host=self.config['host'],
            port=self.config['port'],
            dbname=self.config['dbname'],
            user=self.config['user'],
            password=self.config['password'],
            sslmode="require",
            connect_timeout=5
        )
        self.conn.autocommit = True
        
    def cursor(self):
        try:
            if self.conn is None or self.conn.closed:
                self.connect()
        except Exception:
            self.connect()
        return PostgresCursorWrapper(self.conn.cursor())
        
    def commit(self):
        try:
            if self.conn and not self.conn.closed:
                self.conn.commit()
        except Exception:
            pass
            
    def rollback(self):
        try:
            if self.conn and not self.conn.closed:
                self.conn.rollback()
        except Exception:
            pass
            
    def close(self):
        if self.conn is not None:
            if self.pool is not None and not self.conn.closed:
                try:
                    self.pool.putconn(self.conn)
                except Exception:
                    pass
            else:
                try:
                    self.conn.close()
                except Exception:
                    pass
            self.conn = None
        
    def real_close(self):
        self.close()

    def __enter__(self):
        return self
        
    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is not None:
            self.rollback()
        else:
            self.commit()
        self.close()
        return False

# Windows direct printing dependencies for PyInstaller bundling
try:
    import win32print
    import win32ui
    import win32con
    from PIL import Image, ImageDraw, ImageFont, ImageWin
    import barcode
except Exception:
    pass

# MySQL Database Compatibility Wrapper for SQLite syntax
db_is_ready = False
mysql_config = None

def is_mysql_configured():
    return False # Forced SQLite/Postgres fallback
    global db_is_ready, mysql_config
    if db_is_ready:
        return True
        
    config_path = os.path.join(app_data_dir, 'mysql_config.json')
    if not os.path.exists(config_path):
        return False
        
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            mysql_config = json.load(f)
            
        if mysql_config.get('use_tunnel', False):
            # Test tunnel connection
            conn = HTTPConnectionWrapper(mysql_config)
            cursor = conn.cursor()
            cursor.execute("SELECT 1")
            db_is_ready = True
            return True
            
        # Test direct MySQL connection
        conn = pymysql.connect(
            host=mysql_config['host'],
            port=int(mysql_config.get('port', 3306)),
            user=mysql_config['user'],
            password=mysql_config['password'],
            database=mysql_config['database'],
            connect_timeout=3
        )
        conn.close()
        db_is_ready = True
        return True
    except Exception as e:
        print(f"Database connection test failed: {e}")
        return False

class MySQLRow:
    def __init__(self, cursor, row_tuple):
        self._keys = [desc[0] for desc in cursor.description]
        self._row = row_tuple
    def __getitem__(self, key):
        if isinstance(key, int):
            return self._row[key]
        else:
            try:
                idx = self._keys.index(key)
                return self._row[idx]
            except ValueError:
                raise KeyError(f"Column '{key}' not found in row. Available: {self._keys}")
    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default
    def __len__(self):
        return len(self._row)
    def keys(self):
        return self._keys
    def __iter__(self):
        return iter(self._keys)

class MySQLCursorWrapper:
    def __init__(self, cursor):
        self.cursor = cursor
    def execute(self, query, params=None):
        # Translate SQLite query placeholders and auto-increments to MySQL compatibility
        query_mysql = query.replace('?', '%s')
        query_mysql = query_mysql.replace('INSERT OR REPLACE INTO', 'REPLACE INTO')
        query_mysql = query_mysql.replace("datetime('now', 'localtime')", "NOW()")
        query_mysql = query_mysql.replace("datetime('now', 'localtime')", "NOW()")
        query_mysql = query_mysql.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'INT AUTO_INCREMENT PRIMARY KEY')
        query_mysql = query_mysql.replace('TEXT PRIMARY KEY', 'VARCHAR(255) PRIMARY KEY')
        query_mysql = query_mysql.replace('TEXT UNIQUE', 'VARCHAR(255) UNIQUE')
        query_mysql = query_mysql.replace('TIMESTAMP DEFAULT (datetime(\'now\', \'localtime\'))', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
        
        # Wrap settings table column names in backticks (key/value are reserved keywords in MySQL/MariaDB)
        if 'settings' in query_mysql.lower():
            import re
            query_mysql = re.sub(r'\bkey\b', '`key`', query_mysql)
            query_mysql = re.sub(r'\bvalue\b', '`value`', query_mysql)
        
        if params is not None:
            if not isinstance(params, (list, tuple)):
                params = (params,)
            self.cursor.execute(query_mysql, params)
        else:
            self.cursor.execute(query_mysql)
            
    def fetchone(self):
        row = self.cursor.fetchone()
        if row is None:
            return None
        return MySQLRow(self.cursor, row)
        
    def fetchall(self):
        rows = self.cursor.fetchall()
        return [MySQLRow(self.cursor, r) for r in rows]
        
    @property
    def lastrowid(self):
        return self.cursor.lastrowid
        
    @property
    def rowcount(self):
        return self.cursor.rowcount
        
    def __iter__(self):
        return self
        
    def __next__(self):
        row = self.cursor.fetchone()
        if row is None:
            raise StopIteration
        return MySQLRow(self.cursor, row)

class MySQLConnectionWrapper:
    def __init__(self, conn):
        self.conn = conn
    def cursor(self):
        return MySQLCursorWrapper(self.conn.cursor())
    def commit(self):
        self.conn.commit()
    def rollback(self):
        self.conn.rollback()
    def close(self):
        self.conn.close()

# --- HTTP DATABASE TUNNEL WRAPPERS ---

class HTTPRow:
    def __init__(self, description, row_dict):
        self._keys = [desc[0] for desc in description]
        self._row_dict = row_dict
    def __getitem__(self, key):
        if isinstance(key, int):
            col_name = self._keys[key]
            return self._row_dict[col_name]
        else:
            return self._row_dict[key]
    def get(self, key, default=None):
        return self._row_dict.get(key, default)
    def __len__(self):
        return len(self._row_dict)
    def keys(self):
        return self._keys
    def __iter__(self):
        return iter(self._keys)

class HTTPCursorWrapper:
    def __init__(self, conn):
        self.conn = conn
        self.lastrowid = None
        self.rowcount = 0
        self._rows = []
        self._current_idx = 0
        self.description = []
        
    def execute(self, query, params=None):
        # Translate query placeholders and auto-increments
        query_mysql = query.replace('?', '%s')
        query_mysql = query_mysql.replace('INSERT OR REPLACE INTO', 'REPLACE INTO')
        query_mysql = query_mysql.replace("datetime('now', 'localtime')", "NOW()")
        query_mysql = query_mysql.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'INT AUTO_INCREMENT PRIMARY KEY')
        query_mysql = query_mysql.replace('TEXT PRIMARY KEY', 'VARCHAR(255) PRIMARY KEY')
        query_mysql = query_mysql.replace('TEXT UNIQUE', 'VARCHAR(255) UNIQUE')
        query_mysql = query_mysql.replace('TIMESTAMP DEFAULT (datetime(\'now\', \'localtime\'))', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
        
        # Wrap settings table column names in backticks (key/value are reserved keywords in MySQL/MariaDB)
        if 'settings' in query_mysql.lower():
            import re
            query_mysql = re.sub(r'\bkey\b', '`key`', query_mysql)
            query_mysql = re.sub(r'\bvalue\b', '`value`', query_mysql)
        
        post_data = {
            "query": query_mysql,
            "params": list(params) if params is not None else [],
            "db_host": self.conn.db_host,
            "db_port": self.conn.db_port,
            "db_name": self.conn.db_name,
            "db_user": self.conn.db_user,
            "db_pass": self.conn.db_pass
        }
        
        headers = {
            "Content-Type": "application/json",
            "X-Auth-Token": self.conn.api_key
        }
        
        # Auto-inject Host header for routing on custom IP bindings
        if '178.218.207.135' in self.conn.tunnel_url:
            headers['Host'] = 'neonix.uz'
            
        try:
            req = urllib.request.Request(
                self.conn.tunnel_url,
                data=json.dumps(post_data).encode('utf-8'),
                headers=headers,
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=10) as response:
                resp_data = json.loads(response.read().decode('utf-8'))
                
            if 'rows' in resp_data:
                self._rows = resp_data['rows']
                self.description = []
                if self._rows:
                    self.description = [(k,) for k in self._rows[0].keys()]
                self.rowcount = len(self._rows)
            else:
                self.rowcount = resp_data.get('affected_rows', 0)
                self.lastrowid = resp_data.get('last_insert_id')
                self._rows = []
                self.description = []
                
            self._current_idx = 0
            
        except Exception as e:
            if hasattr(e, 'read'):
                try:
                    err_body = e.read().decode('utf-8')
                    err_json = json.loads(err_body)
                    if 'error' in err_json:
                        raise Exception(err_json['error'])
                except Exception:
                    pass
            raise e
            
    def fetchone(self):
        if self._current_idx < len(self._rows):
            row_dict = self._rows[self._current_idx]
            self._current_idx += 1
            return HTTPRow(self.description, row_dict)
        return None
        
    def fetchall(self):
        result = [HTTPRow(self.description, r) for r in self._rows[self._current_idx:]]
        self._current_idx = len(self._rows)
        return result
        
    def __iter__(self):
        return self
        
    def __next__(self):
        row = self.fetchone()
        if row is None:
            raise StopIteration
        return row

class HTTPConnectionWrapper:
    def __init__(self, config):
        self.tunnel_url = config['tunnel_url']
        self.api_key = config['api_key']
        self.db_host = config.get('host', 'localhost')
        self.db_port = int(config.get('port', 3306))
        self.db_name = config.get('database', '')
        self.db_user = config.get('user', '')
        self.db_pass = config.get('password', '')
        
    def cursor(self):
        return HTTPCursorWrapper(self)
    def commit(self):
        pass
    def rollback(self):
        pass
    def close(self):
        pass



# Version, VPS and FTP Configuration settings
APP_VERSION = "1.98"
VPS_HOST = "89.124.92.53"
VPS_UPDATE_URL = f"http://{VPS_HOST}/updates/version.txt"
VPS_DOWNLOAD_URL = f"http://{VPS_HOST}/updates/easy-crm.exe"

FTP_HOST = "178.218.207.135"
FTP_PORT = 21
FTP_USER = "user1309"
FTP_PASS = "649260254b"

from ftplib import FTP
import shutil
import threading

ftp_upload_lock = threading.Lock()
last_successful_upload_time = None

# In-memory ultra-fast caches for instant UI interactions
_cached_setup_complete = None
_cached_owner_password_hash = None
_cached_cashiers = None
_cached_cashiers_map = None
_cached_active_shift = None
_cached_active_shift_ts = 0
_latest_remote_version = None
_latest_remote_check_ts = 0

def hash_password(password):
    return hashlib.sha256(password.encode('utf-8')).hexdigest()

def show_windows_messagebox(title, message, is_error=True):
    try:
        import ctypes
        style = 0x10 if is_error else 0x40  # 0x10 = MB_ICONERROR, 0x40 = MB_ICONINFORMATION
        ctypes.windll.user32.MessageBoxW(0, message, title, style)
    except Exception as e:
        print(f"Failed to show ctypes MessageBox: {e}")

def get_ftp_connection():
    if not FTP_HOST:
        return None
    try:
        ftp = FTP()
        ftp.connect(FTP_HOST, FTP_PORT, timeout=5)
        ftp.login(FTP_USER, FTP_PASS)
        return ftp
    except Exception as e:
        print(f"FTP Connection error: {e}")
        return None

def check_for_updates():
    remote_version = None
    update_source = None
    
    # 1. Primary check: Dedicated VPS HTTP endpoint
    try:
        req = urllib.request.Request(VPS_UPDATE_URL, headers={'User-Agent': f'EasyCRM/{APP_VERSION}'})
        with urllib.request.urlopen(req, timeout=4) as resp:
            if resp.status == 200:
                v_text = resp.read().decode('utf-8').strip()
                if v_text:
                    remote_version = v_text
                    update_source = 'VPS_HTTP'
                    print(f"Checked updates on VPS: remote version is {remote_version}")
    except Exception as e:
        print(f"VPS HTTP update check skipped/error: {e}")

    # 2. Fallback check: FTP server
    if not remote_version:
        ftp = get_ftp_connection()
        if ftp:
            try:
                files = ftp.nlst()
                if "version.txt" in files:
                    remote_version_bytes = []
                    ftp.retrbinary("RETR version.txt", remote_version_bytes.append)
                    remote_version = b"".join(remote_version_bytes).decode('utf-8').strip()
                    update_source = 'FTP'
                    print(f"Checked updates on FTP: remote version is {remote_version}")
            except Exception as e:
                print(f"Error checking updates over FTP: {e}")
            finally:
                try: ftp.quit()
                except: pass

    if not remote_version:
        return False

    global _latest_remote_version, _latest_remote_check_ts
    _latest_remote_version = remote_version
    _latest_remote_check_ts = time.time()

    try:
        local_v = float(APP_VERSION)
        remote_v = float(remote_version)
    except Exception as e:
        print(f"Version comparison parse error: {e}")
        return False

    if remote_v > local_v:
        print(f"Update available ({update_source}): {local_v} -> {remote_v}")
        # Ask user if they want to update now
        try:
            import ctypes
            # MB_YESNO (0x04) | MB_ICONQUESTION (0x20) | MB_SYSTEMMODAL (0x1000) | MB_TOPMOST (0x40000)
            res = ctypes.windll.user32.MessageBoxW(
                0, 
                f"Вышла новая версия Easy CRM (v{remote_version})!\nУ вас установлена v{APP_VERSION}.\n\nОбновить приложение прямо сейчас с вашего VPS сервера?", 
                "Доступно обновление Easy CRM", 
                0x04 | 0x20 | 0x1000 | 0x40000
            )
            if res != 6: # 6 = IDYES
                print("User declined update for now.")
                return False
        except Exception as e:
            print(f"MessageBox prompt error: {e}")
            
        try:
            Timer(0.1, lambda: show_windows_messagebox("Загрузка обновления", f"Загружается версия {remote_version} с VPS сервера...\nПожалуйста, подождите несколько секунд.", is_error=False)).start()
        except Exception:
            pass

        temp_new_exe = "easy-crm-new.exe"
        download_success = False

        # Attempt download from VPS HTTP first
        if update_source == 'VPS_HTTP' or VPS_DOWNLOAD_URL:
            try:
                print(f"Downloading {remote_version} from {VPS_DOWNLOAD_URL}...")
                req = urllib.request.Request(VPS_DOWNLOAD_URL, headers={'User-Agent': f'EasyCRM/{APP_VERSION}'})
                with urllib.request.urlopen(req, timeout=60) as resp, open(temp_new_exe, "wb") as f:
                    while True:
                        chunk = resp.read(131072) # 128KB chunks
                        if not chunk:
                            break
                        f.write(chunk)
                download_success = True
                print("Download from VPS HTTP complete.")
            except Exception as dl_err:
                print(f"HTTP download from VPS failed: {dl_err}. Falling back to FTP if available...")

        # If HTTP failed, fallback to FTP
        if not download_success:
            ftp = get_ftp_connection()
            if ftp:
                try:
                    ftp.voidcmd('TYPE I')
                    with open(temp_new_exe, "wb") as f:
                        ftp.retrbinary("RETR easy-crm.exe", f.write)
                    download_success = True
                    print("Download from FTP complete.")
                except Exception as ftp_dl_err:
                    print(f"FTP download error: {ftp_dl_err}")
                finally:
                    try: ftp.quit()
                    except: pass

        local_file_size = os.path.getsize(temp_new_exe) if os.path.exists(temp_new_exe) else 0
        if not download_success or local_file_size < 10000000:
            print(f"Incomplete download: {local_file_size} bytes")
            try: os.remove(temp_new_exe)
            except: pass
            show_windows_messagebox("Ошибка обновления", "Файл обновления загрузился не полностью. Попробуйте еще раз.")
            return False

        return True
    return False

def trigger_update_and_exit():
    try:
        current_exe = sys.executable if getattr(sys, 'frozen', False) else 'easy-crm.exe'
        current_dir = os.path.dirname(os.path.abspath(current_exe))
        exe_name = os.path.basename(current_exe)
        
        bat_content = f"""@echo off
setlocal
cd /d "{current_dir}"
timeout /t 1 /nobreak > nul
taskkill /f /im "{exe_name}" > nul 2>&1
timeout /t 1 /nobreak > nul
:retry_copy
if exist easy-crm-new.exe (
    copy /y easy-crm-new.exe "{exe_name}" > nul 2>&1
    if errorlevel 1 (
        timeout /t 1 /nobreak > nul
        goto retry_copy
    )
    del easy-crm-new.exe > nul 2>&1
    start "" "{exe_name}"
)
del "%~f0" > nul 2>&1
exit
"""
        with open("update.bat", "w", encoding="utf-8") as f:
            f.write(bat_content)
        import subprocess
        subprocess.Popen("update.bat", shell=True, creationflags=subprocess.CREATE_NO_WINDOW)
        os._exit(0)
    except Exception as e:
        print(f"Failed to launch auto-updater script: {e}")

# Configure paths for PyInstaller bundle compatibility
if getattr(sys, 'frozen', False):
    # PyInstaller temp folder
    template_folder = os.path.join(sys._MEIPASS, 'templates')
    static_folder = os.path.join(sys._MEIPASS, 'static')
    db_dir = os.path.dirname(sys.executable)
else:
    # Local dev directory
    template_folder = os.path.join(os.path.dirname(__file__), 'templates')
    static_folder = os.path.join(os.path.dirname(__file__), 'static')
    db_dir = os.path.dirname(__file__)

# Fixed, persistent app data directory in user profile
user_home = os.path.expanduser('~')
app_data_dir = os.path.join(user_home, '.easy_crm')
if not os.path.exists(app_data_dir):
    os.makedirs(app_data_dir)

# Target DB path
db_path = os.path.join(app_data_dir, 'database.db')

def sync_db_from_ftp_sync():
    global last_successful_upload_time
    ftp = get_ftp_connection()
    if not ftp:
        return
    try:
        files = ftp.nlst()
        if "database.db" in files:
            print("FTP Sync: Comparing local and remote databases...")
            os.makedirs(os.path.dirname(db_path), exist_ok=True)
            temp_db = db_path + ".tmp_ftp"
            with open(temp_db, "wb") as f:
                ftp.retrbinary("RETR database.db", f.write)
                
            local_time = None
            if os.path.exists(db_path):
                try:
                    conn = sqlite3.connect(db_path)
                    conn.row_factory = sqlite3.Row
                    row = conn.execute("SELECT value FROM settings WHERE key = 'last_db_write'").fetchone()
                    if row:
                        local_time = row['value']
                    conn.close()
                except Exception as le:
                    pass
                    
            remote_time = None
            try:
                conn = sqlite3.connect(temp_db)
                conn.row_factory = sqlite3.Row
                row = conn.execute("SELECT value FROM settings WHERE key = 'last_db_write'").fetchone()
                if row:
                    remote_time = row['value']
                conn.close()
            except Exception as re:
                pass
                
            if remote_time and (not local_time or remote_time > local_time):
                if os.path.exists(db_path):
                    os.remove(db_path)
                os.rename(temp_db, db_path)
                print(f"FTP Sync: Local database updated to remote version (Remote: {remote_time} > Local: {local_time or 'None'})")
                last_successful_upload_time = remote_time
            elif local_time and (not remote_time or local_time > remote_time):
                print(f"FTP Sync: Local database is newer (Local: {local_time} > Remote: {remote_time or 'None'}). Uploading local database...")
                if os.path.exists(temp_db):
                    os.remove(temp_db)
                try: ftp.quit()
                except: pass
                upload_db_to_ftp_sync()
                last_successful_upload_time = local_time
            else:
                print("FTP Sync: Databases are in sync.")
                if os.path.exists(temp_db):
                    os.remove(temp_db)
                last_successful_upload_time = local_time or remote_time
    except Exception as e:
        print(f"Failed to sync database on startup: {e}")
        if os.path.exists(db_path + ".tmp_ftp"):
            try: os.remove(db_path + ".tmp_ftp")
            except: pass
    finally:
        try: ftp.quit()
        except: pass

def upload_db_to_ftp_sync():
    global last_successful_upload_time
    if not ftp_upload_lock.acquire(blocking=False):
        print("FTP upload already in progress. Skipping duplicate upload request.")
        return False
    success = False
    try:
        ftp = get_ftp_connection()
        if not ftp:
            return False
        try:
            temp_upload = db_path + ".tmp_upload"
            if os.path.exists(temp_upload):
                try: os.remove(temp_upload)
                except: pass
            if os.path.exists(db_path):
                shutil.copy2(db_path, temp_upload)
                
                local_time = None
                try:
                    conn = sqlite3.connect(temp_upload)
                    row = conn.execute("SELECT value FROM settings WHERE key = 'last_db_write'").fetchone()
                    if row:
                        local_time = row[0]
                    conn.close()
                except:
                    pass
                    
                with open(temp_upload, "rb") as f:
                    ftp.storbinary("STOR database.db", f)
                print("Database uploaded successfully to FTP.")
                if local_time:
                    last_successful_upload_time = local_time
                success = True
                try: os.remove(temp_upload)
                except: pass
        except Exception as e:
            print(f"Failed to upload database to FTP: {e}")
        finally:
            try: ftp.quit()
            except: pass
    finally:
        ftp_upload_lock.release()
    return success

def sync_db_to_ftp_async():
    threading.Thread(target=upload_db_to_ftp_sync, daemon=True).start()

def ftp_sync_loop():
    global last_successful_upload_time
    time.sleep(30)
    while True:
        try:
            local_time = None
            if os.path.exists(db_path):
                try:
                    conn = sqlite3.connect(db_path)
                    row = conn.execute("SELECT value FROM settings WHERE key = 'last_db_write'").fetchone()
                    if row:
                        local_time = row[0]
                    conn.close()
                except Exception as le:
                    pass
            
            if local_time and (not last_successful_upload_time or local_time > last_successful_upload_time):
                print(f"FTP Sync Loop: Found pending local writes ({local_time}). Syncing database to FTP...")
                upload_db_to_ftp_sync()
        except Exception as loop_err:
            print(f"Error in FTP sync loop: {loop_err}")
        time.sleep(60)

# Automatic migration from legacy database positions
legacy_paths = [
    os.path.join(db_dir, 'database.db'),
    os.path.join(db_dir, 'dist', 'database.db')
]
for legacy_path in legacy_paths:
    if os.path.exists(legacy_path) and os.path.abspath(legacy_path) != os.path.abspath(db_path):
        try:
            # Only migrate if new DB doesn't exist yet, to prevent overwriting newer database
            if not os.path.exists(db_path):
                import shutil
                shutil.copy2(legacy_path, db_path)
                print(f"Migrated legacy database from {legacy_path} to {db_path}")
        except Exception as e:
            print(f"Failed to migrate database: {e}")

app = Flask(__name__, template_folder=template_folder, static_folder=static_folder)
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

@app.after_request
def add_no_cache_headers(response):
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

# --- SYSTEM UPDATE API ENDPOINTS ---

@app.route('/api/system/version', methods=['GET'])
def get_system_version():
    global _latest_remote_version, _latest_remote_check_ts
    now = time.time()
    if _latest_remote_version is None or (now - _latest_remote_check_ts > 60):
        try:
            req = urllib.request.Request(VPS_UPDATE_URL, headers={'User-Agent': f'EasyCRM/{APP_VERSION}'})
            with urllib.request.urlopen(req, timeout=3) as resp:
                if resp.status == 200:
                    v_text = resp.read().decode('utf-8').strip()
                    if v_text:
                        _latest_remote_version = v_text
                        _latest_remote_check_ts = now
        except Exception:
            pass
            
    remote_v = _latest_remote_version or APP_VERSION
    update_available = False
    try:
        update_available = float(remote_v) > float(APP_VERSION)
    except Exception:
        update_available = (remote_v != APP_VERSION)
        
    return jsonify({
        "success": True,
        "current_version": APP_VERSION,
        "remote_version": remote_v,
        "update_available": update_available
    })

@app.route('/api/system/apply_update', methods=['POST'])
def apply_system_update():
    global _latest_remote_version
    remote_version = _latest_remote_version or APP_VERSION
    temp_new_exe = "easy-crm-new.exe"
    download_success = False

    try:
        print(f"Web client requested update download from {VPS_DOWNLOAD_URL}...")
        req = urllib.request.Request(VPS_DOWNLOAD_URL, headers={'User-Agent': f'EasyCRM/{APP_VERSION}'})
        with urllib.request.urlopen(req, timeout=60) as resp, open(temp_new_exe, "wb") as f:
            while True:
                chunk = resp.read(131072)
                if not chunk:
                    break
                f.write(chunk)
        download_success = True
    except Exception as dl_err:
        print(f"VPS HTTP download failed: {dl_err}. Falling back to FTP...")

    if not download_success:
        ftp = get_ftp_connection()
        if ftp:
            try:
                ftp.voidcmd('TYPE I')
                with open(temp_new_exe, "wb") as f:
                    ftp.retrbinary("RETR easy-crm.exe", f.write)
                download_success = True
            except Exception as ftp_err:
                print(f"FTP download error: {ftp_err}")
            finally:
                try: ftp.quit()
                except: pass

    local_size = os.path.getsize(temp_new_exe) if os.path.exists(temp_new_exe) else 0
    if not download_success or local_size < 10000000:
        if os.path.exists(temp_new_exe):
            try: os.remove(temp_new_exe)
            except: pass
        return jsonify({"success": False, "message": "Не удалось загрузить файл обновления с сервера. Проверьте интернет-соединение."}), 500

    Timer(0.8, trigger_update_and_exit).start()
    return jsonify({"success": True, "message": "Обновление успешно загружено. Приложение перезапускается..."})

# --- DATABASE SETUP INTERCEPTS & ENDPOINTS ---

@app.before_request
def check_db_configuration():
    return # Temporarily disabled MySQL setup redirect
    # Allow static resources, db setup endpoints, and logos
    if request.path.startswith('/static/') or request.path in ['/setup-db', '/api/setup-db', '/api/setup-db/migrate']:
        return
        
    if not is_mysql_configured():
        return render_template('db_setup.html')

@app.route('/setup-db', methods=['GET'])
def get_db_setup():
    return render_template('db_setup.html')

@app.route('/api/setup-db', methods=['POST'])
def save_db_setup():
    global db_is_ready, mysql_config
    data = request.json or {}
    
    use_tunnel = data.get('use_tunnel', False)
    tunnel_url = data.get('tunnel_url', '').strip()
    api_key = data.get('api_key', '').strip()
    
    host = data.get('host', '').strip()
    port = int(data.get('port', 3306))
    database = data.get('database', '').strip()
    user = data.get('user', '').strip()
    password = data.get('password', '')
    
    test_config = {
        "use_tunnel": use_tunnel,
        "tunnel_url": tunnel_url,
        "api_key": api_key,
        "host": host,
        "port": port,
        "database": database,
        "user": user,
        "password": password
    }
    
    try:
        if use_tunnel:
            conn = HTTPConnectionWrapper(test_config)
            cursor = conn.cursor()
            cursor.execute("SELECT 1")
        else:
            conn = pymysql.connect(
                host=host,
                port=port,
                user=user,
                password=password,
                database=database,
                connect_timeout=3
            )
            conn.close()
    except Exception as e:
        return jsonify({"success": False, "message": f"Не удалось подключиться: {str(e)}"}), 400
        
    config_path = os.path.join(app_data_dir, 'mysql_config.json')
    mysql_config = test_config
    
    try:
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(mysql_config, f, indent=4)
        db_is_ready = True
        
        # Initialize tables on MySQL (direct or tunnel)
        init_db()
        
        return jsonify({"success": True, "message": "Настройки успешно сохранены!"})
    except Exception as e:
        return jsonify({"success": False, "message": f"Ошибка сохранения настроек: {str(e)}"}), 500

@app.route('/api/setup-db/migrate', methods=['POST'])
def migrate_sqlite_to_mysql():
    if not is_mysql_configured():
        return jsonify({"success": False, "message": "База данных MySQL не настроена"}), 400
        
    sqlite_db_path = os.path.join(app_data_dir, 'database.db')
    if not os.path.exists(sqlite_db_path):
        return jsonify({"success": False, "message": "Файл локальной базы данных SQLite не найден"}), 404
        
    try:
        # Connect to SQLite
        lite_conn = sqlite3.connect(sqlite_db_path)
        lite_conn.row_factory = sqlite3.Row
        lite_cursor = lite_conn.cursor()
        
        # Connect to MySQL
        my_conn = get_db_connection()
        my_cursor = my_conn.cursor()
        
        # Table list in migration order (dependencies first)
        tables = ['settings', 'cashiers', 'products', 'shifts', 'sales', 'expenses', 'purchases', 'write_offs', 'wishes', 'discrepancies']
        
        for table in tables:
            # Check if table exists in SQLite
            try:
                lite_cursor.execute(f"SELECT * FROM {table}")
                rows = lite_cursor.fetchall()
            except sqlite3.OperationalError:
                continue
                
            if not rows:
                continue
                
            # Clear target MySQL table to avoid duplicate keys during migration
            # Temporarily disable foreign key checks
            my_cursor.cursor.execute("SET FOREIGN_KEY_CHECKS = 0")
            my_cursor.cursor.execute(f"DELETE FROM {table}")
            
            # Prepare insert query
            columns = rows[0].keys()
            cols_str = ", ".join(columns)
            placeholders = ", ".join(["%s"] * len(columns))
            insert_query = f"INSERT INTO {table} ({cols_str}) VALUES ({placeholders})"
            
            for row in rows:
                values = [row[col] for col in columns]
                my_cursor.execute(insert_query, values)
                
            my_cursor.cursor.execute("SET FOREIGN_KEY_CHECKS = 1")
            
        my_conn.commit()
        lite_conn.close()
        my_conn.close()
        
        return jsonify({"success": True, "message": "Данные успешно импортированы из SQLite в MySQL!"})
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "message": f"Ошибка миграции: {str(e)}"}), 500


@app.after_request
def after_request_callback(response):
    # 1. Invalidate catalog cache and trigger sync on state-changing requests
    if request.method in ['POST', 'PUT', 'DELETE']:
        if response.status_code in [200, 201]:
            bump_catalog_version()
            path = request.path
            db_modifying_prefixes = [
                '/api/sales', '/api/products', '/api/shift', '/api/expenses', 
                '/api/purchases', '/api/audit', '/api/discrepancies', '/api/wishes',
                '/api/cashiers', '/api/auth/change_owner_password', '/api/gdrive'
            ]
            if any(path.startswith(prefix) for prefix in db_modifying_prefixes):
                try:
                    conn = sqlite3.connect(db_path, timeout=10.0)
                    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_db_write', datetime('now', 'localtime'))")
                    conn.commit()
                    conn.close()
                except Exception as db_err:
                    print(f"Error marking DB write: {db_err}")
                sync_db_to_ftp_async()

    # 2. Transparent Gzip compression for large JSON and HTML responses (> 500 bytes)
    try:
        accept_encoding = request.headers.get('Accept-Encoding', '')
        if ('gzip' in accept_encoding and 
            response.status_code == 200 and 
            not response.direct_passthrough and 
            (response.mimetype.startswith('text/') or response.mimetype == 'application/json') and
            len(response.get_data()) > 500 and
            'Content-Encoding' not in response.headers):
            
            response_data = response.get_data()
            compressed_data = gzip.compress(response_data, compresslevel=6)
            response.set_data(compressed_data)
            response.headers['Content-Encoding'] = 'gzip'
            response.headers['Content-Length'] = len(compressed_data)
            response.headers['Vary'] = 'Accept-Encoding'
    except Exception as comp_err:
        pass

    return response

# License configurations
LICENSE_PATH = os.path.join(app_data_dir, 'easy_crm.lic')
VALID_LICENSE_KEY = "EASY-CRM-LIC-2026-ACTIVE"
_cached_license_valid = False

def check_license():
    global _cached_license_valid
    if _cached_license_valid:
        return True
    if not os.path.exists(LICENSE_PATH):
        return False
    try:
        with open(LICENSE_PATH, 'r', encoding='utf-8') as f:
            content = f.read().strip()
            if content == VALID_LICENSE_KEY:
                _cached_license_valid = True
                return True
            return False
    except Exception:
        return False

def calculate_shift_sales(cursor, shift_id):
    # 1. Non-mix sales:
    cursor.execute('''
        SELECT payment_method, SUM(price_final * quantity) as total
        FROM sales
        WHERE shift_id = ? AND (payment_method != 'mix' OR payment_method IS NULL)
        GROUP BY payment_method
    ''', (shift_id,))
    
    cash_actual = 0.0
    card_actual = 0.0
    transfer_actual = 0.0
    for row in cursor.fetchall():
        method = row['payment_method']
        total = float(row['total'] or 0.0)
        if method == 'cash':
            cash_actual += total
        elif method == 'card':
            card_actual += total
        elif method == 'transfer':
            transfer_actual += total
            
    # 2. Mix sales:
    cursor.execute('''
        SELECT COALESCE(SUM(mix_cash), 0) as mix_cash_total, COALESCE(SUM(mix_card), 0) as mix_card_total
        FROM sales
        WHERE shift_id = ? AND payment_method = 'mix'
    ''', (shift_id,))
    mix_row = cursor.fetchone()
    if mix_row:
        cash_actual += float(mix_row['mix_cash_total'] or 0.0)
        card_actual += float(mix_row['mix_card_total'] or 0.0)
        
    return cash_actual, card_actual, transfer_actual

def auto_close_shifts_if_needed():
    import datetime
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT * FROM shifts WHERE status = 'open' LIMIT 1")
        row = cursor.fetchone()
        if row:
            shift = dict(row)
            opened_at_str = shift.get('opened_at')
            if isinstance(opened_at_str, (datetime.datetime, datetime.date)):
                opened_dt = opened_at_str
            else:
                opened_dt = datetime.datetime.strptime(str(opened_at_str).split('.')[0], '%Y-%m-%d %H:%M:%S')
            current_dt = datetime.datetime.now()
            
            # If current calendar day is past the opened day, auto-close it (with safety buffer of at least 4 hours)
            time_diff = (current_dt - opened_dt).total_seconds()
            if current_dt.date() > opened_dt.date() and time_diff > 14400:
                shift_id = shift['id']
                
                # Calculate sales for the shift
                cash_actual, card_actual, transfer_actual = calculate_shift_sales(cursor, shift_id)
                        
                # Set closing time to 23:59:59 of the opened day to keep reports aligned
                closed_at_str = opened_dt.strftime('%Y-%m-%d 23:59:59')
                cash_end = shift['cash_start'] + cash_actual
                
                cursor.execute('''
                    UPDATE shifts
                    SET status = 'closed', closed_at = ?, closed_by = ?, cash_end = ?,
                        cash_actual = ?, card_actual = ?, transfer_actual = ?
                    WHERE id = ?
                ''', (closed_at_str, "Автозакрытие", cash_end, cash_actual, card_actual, transfer_actual, shift_id))
                
                conn.commit()
                print(f"Shift #{shift_id} auto-closed at midnight successfully.")
                
                # Trigger backup
                try:
                    upload_report_to_gdrive()
                except Exception as e:
                    print(f"Error syncing report after auto-close: {e}")
    except Exception as e:
        print(f"Error in auto_close_shifts_if_needed: {e}")
    finally:
        conn.close()

def auto_close_shifts_loop():
    """Background daemon thread to auto-close shifts past midnight every 10 minutes without blocking requests."""
    while True:
        try:
            time.sleep(600)
            auto_close_shifts_if_needed()
        except Exception as e:
            print(f"Error in auto_close_shifts_loop: {e}")

@app.before_request
def enforce_license():
    # Instant bypass for static resources, license verification endpoint, and favicon
    if request.path.startswith('/static') or request.path in ['/api/license/activate', '/favicon.ico']:
        return
        
    if not check_license():
        if request.path.startswith('/api/'):
            return jsonify({"success": False, "license_error": True, "message": "Лицензия неактивна или не найдена. Пожалуйста, активируйте приложение."}), 402
        return render_template('license.html')

@app.route('/api/license/activate', methods=['POST'])
def activate_license():
    data = request.json or {}
    key = data.get('key', '').strip()
    if key != VALID_LICENSE_KEY:
        return jsonify({"success": False, "message": "Неверный лицензионный ключ!"}), 400
        
    try:
        with open(LICENSE_PATH, 'w', encoding='utf-8') as f:
            f.write(VALID_LICENSE_KEY)
        return jsonify({"success": True, "message": "Лицензия успешно активирована"})
    except PermissionError:
        return jsonify({
            "success": False,
            "message": "Ошибка прав доступа: Не удалось записать файл лицензии в домашнюю директорию. Убедитесь, что у вас есть права на запись в папку пользователя."
        }), 500
    except Exception as e:
        return jsonify({"success": False, "message": f"Ошибка активации: {str(e)}"}), 500

# Load or generate secret key persistently
def load_secret_key():
    try:
        conn = sqlite3.connect(db_path, timeout=10.0)
        cursor = conn.cursor()
        cursor.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")
        cursor.execute("SELECT value FROM settings WHERE key = 'secret_key'")
        row = cursor.fetchone()
        if row:
            key = row[0]
        else:
            import secrets
            key = secrets.token_hex(32)
            cursor.execute("INSERT INTO settings (key, value) VALUES ('secret_key', ?)", (key,))
            conn.commit()
        conn.close()
        return key
    except Exception:
        # Fallback if DB is locked during startup
        return 'super_secret_crm_key_fallback_random_1928'

app.secret_key = load_secret_key()


def format_currency(value):
    if value is None:
        return "0"
    return f"{int(round(value)):,}".replace(",", " ")

def get_db_connection():
    if psycopg2 is not None:
        if has_request_context():
            db = getattr(g, '_database', None)
            if db is not None:
                return db
            try:
                db = g._database = PostgresConnectionWrapper(SUPABASE_CONFIG)
                return db
            except Exception as e:
                print(f"Supabase connection failed, falling back to local SQLite: {e}")
        else:
            try:
                return PostgresConnectionWrapper(SUPABASE_CONFIG)
            except Exception as e:
                print(f"Supabase connection failed, falling back to local SQLite: {e}")
                
    # Fallback to local SQLite
    conn = sqlite3.connect(db_path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    return conn

@app.teardown_appcontext
def close_connection(exception):
    db = getattr(g, '_database', None)
    if db is not None:
        try:
            if hasattr(db, 'real_close'):
                db.real_close()
            else:
                db.close()
        except Exception:
            pass

def get_or_load_catalog():
    """Returns (catalog_list, barcode_map, id_map), caching in memory for instant responses."""
    global _catalog_cache, _catalog_barcode_map, _catalog_id_map
    with _catalog_lock:
        if _catalog_cache is not None:
            return _catalog_cache, _catalog_barcode_map, _catalog_id_map

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT 
                p.*,
                COALESCE(s_agg.sold_qty, 0) as sold_qty,
                COALESCE(pu_agg.purchase_qty, 0) as purchase_qty,
                COALESCE(w_agg.write_off_qty, 0) as write_off_qty
            FROM products p
            LEFT JOIN (
                SELECT product_id, SUM(quantity) as sold_qty FROM sales GROUP BY product_id
            ) s_agg ON p.id = s_agg.product_id
            LEFT JOIN (
                SELECT product_id, SUM(quantity) as purchase_qty FROM purchases GROUP BY product_id
            ) pu_agg ON p.id = pu_agg.product_id
            LEFT JOIN (
                SELECT product_id, SUM(quantity) as write_off_qty FROM write_offs GROUP BY product_id
            ) w_agg ON p.id = w_agg.product_id
            WHERE p.is_deleted = 0 
            ORDER BY p.name ASC
        """)
        rows = cursor.fetchall()
        conn.close()

        new_catalog = []
        new_barcode_map = {}
        new_id_map = {}

        for row in rows:
            d = dict(row)
            d['initial_qty'] = max(d.get('purchase_qty') or 0, (d.get('stock') or 0) + (d.get('sold_qty') or 0) + (d.get('write_off_qty') or 0))
            new_catalog.append(d)
            new_id_map[d['id']] = d

            raw_bc = str(d.get('barcode') or '')
            for bc in raw_bc.split(','):
                bc_clean = bc.strip()
                if bc_clean:
                    new_barcode_map[bc_clean] = d
                    digits_only = ''.join(c for c in bc_clean if c.isdigit())
                    if digits_only and digits_only not in new_barcode_map:
                        new_barcode_map[digits_only] = d

        with _catalog_lock:
            _catalog_cache = new_catalog
            _catalog_barcode_map = new_barcode_map
            _catalog_id_map = new_id_map

        return _catalog_cache, _catalog_barcode_map, _catalog_id_map
    except Exception as e:
        print(f"Error loading catalog into cache: {e}")
        return [], {}, {}

def find_product_by_barcode(barcode_str):
    """Instant <0.1ms lookup for scanned barcodes via in-memory index."""
    if not barcode_str:
        return None
    b1 = str(barcode_str).strip()
    b2 = ''.join(c for c in b1 if c.isdigit())

    # Fast path: in-memory lookup
    _, b_map, _ = get_or_load_catalog()
    prod = b_map.get(b1) or (b_map.get(b2) if b2 else None)
    if prod:
        return prod

    # If not found in cache, reload once from DB (in case added from another cash desk)
    invalidate_catalog_cache()
    _, b_map, _ = get_or_load_catalog()
    return b_map.get(b1) or (b_map.get(b2) if b2 else None)

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Fast exit if schema migrations have already been completed
    try:
        cursor.execute("SELECT value FROM settings WHERE key = 'schema_migrations_complete'")
        row = cursor.fetchone()
        if row and (row['value'] if isinstance(row, dict) else row[0]) == '1':
            conn.close()
            return
    except Exception:
        pass
    
    # 1. Settings table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    ''')
    
    # 2. Cashiers table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS cashiers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT (datetime('now', 'localtime'))
        )
    ''')
    
    # 3. Products table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            barcode TEXT UNIQUE,
            name TEXT NOT NULL,
            price REAL NOT NULL,
            stock INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT (datetime('now', 'localtime'))
        )
    ''')
    
    # 4. Sales table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sales (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 1,
            price_original REAL NOT NULL,
            discount_percent REAL NOT NULL DEFAULT 0.0,
            price_final REAL NOT NULL,
            sold_at TIMESTAMP DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY(product_id) REFERENCES products(id)
        )
    ''')
    
    # 5. Shifts table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            opened_at TIMESTAMP DEFAULT (datetime('now', 'localtime')),
            closed_at TIMESTAMP,
            opened_by TEXT,
            closed_by TEXT,
            cash_start REAL DEFAULT 0.0,
            cash_end REAL DEFAULT 0.0,
            cash_actual REAL DEFAULT 0.0,
            card_actual REAL DEFAULT 0.0,
            transfer_actual REAL DEFAULT 0.0,
            status TEXT DEFAULT 'open'
        )
    ''')
    
    # 6. Expenses table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            amount REAL NOT NULL,
            category TEXT NOT NULL,
            description TEXT,
            expense_date TIMESTAMP DEFAULT (datetime('now', 'localtime'))
        )
    ''')
    
    # 7. Purchases table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            purchase_price REAL NOT NULL,
            supplier TEXT NOT NULL,
            status TEXT DEFAULT 'paid',
            purchase_date TIMESTAMP DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY(product_id) REFERENCES products(id)
        )
    ''')
    
    # 8. Write-offs table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS write_offs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            reason TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY(product_id) REFERENCES products(id)
        )
    ''')
    
    # 9. Wishes table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS wishes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_name TEXT NOT NULL,
            requested_at TIMESTAMP DEFAULT (datetime('now', 'localtime')),
            cashier_name TEXT NOT NULL
        )
    ''')
    
    # 10. Discrepancies table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS discrepancies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            expected_stock INTEGER NOT NULL,
            actual_stock INTEGER NOT NULL,
            difference INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY(product_id) REFERENCES products(id)
        )
    ''')

    # 11. Services table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            shift_id INTEGER,
            name TEXT NOT NULL,
            amount REAL NOT NULL,
            payment_method TEXT DEFAULT 'cash',
            cashier_name TEXT,
            created_at TIMESTAMP DEFAULT (datetime('now', 'localtime'))
        )
    ''')
    
    # --- migrations and seeding ---
    
    # Schema migrations
    try:
        cursor.execute("ALTER TABLE products ADD COLUMN is_deleted INTEGER DEFAULT 0")
    except Exception:
        pass
        
    try:
        cursor.execute("ALTER TABLE products ADD COLUMN cost_price REAL DEFAULT 0.0")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE products ADD COLUMN supplier TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE products ADD COLUMN type TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE products ADD COLUMN brand TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE products ADD COLUMN model TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE products ADD COLUMN unique_suffix TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE products ADD COLUMN further_spec TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE products ADD COLUMN note TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE sales ADD COLUMN cost_price REAL DEFAULT 0.0")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE sales ADD COLUMN shift_id INTEGER")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE sales ADD COLUMN payment_method TEXT DEFAULT 'cash'")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE expenses ADD COLUMN shift_id INTEGER")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE expenses ADD COLUMN cashier_name TEXT")
    except Exception:
        pass

    # Seed default cashier if not exists
    cursor.execute("SELECT id FROM cashiers WHERE email = 'Alisashadmanova@gmail.com'")
    if not cursor.fetchone():
        hashed_pin = hashlib.sha256("1111".encode('utf-8')).hexdigest()
        cursor.execute("INSERT INTO cashiers (name, email, password) VALUES ('Алиса', 'Alisashadmanova@gmail.com', ?)", (hashed_pin,))
        
    # Migrate empty/null barcodes to compact unique 4-digit formats safely
    cursor.execute("SELECT id, barcode FROM products")
    rows = cursor.fetchall()
    for row in rows:
        prod_id = row['id']
        curr_barcode = (row['barcode'] or '').strip()
        if not curr_barcode:
            temp_id = prod_id
            while True:
                candidate = f"{1000 + temp_id}"
                cursor.execute("SELECT id FROM products WHERE is_deleted = 0 AND (barcode = ? OR instr(barcode, ?))", (candidate, candidate))
                if not cursor.fetchone():
                    cursor.execute("UPDATE products SET barcode = ? WHERE id = ?", (candidate, prod_id))
                    break
                temp_id += 1

    # Local time migrations
    try:
        synced = cursor.execute("SELECT value FROM settings WHERE key = 'time_synced_to_localtime'").fetchone()
        if not synced or synced[0] != '1':
            if is_mysql_configured():
                cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('time_synced_to_localtime', '1')")
            else:
                cursor.execute("UPDATE sales SET sold_at = datetime(sold_at, 'localtime') WHERE sold_at IS NOT NULL")
                cursor.execute("UPDATE shifts SET opened_at = datetime(opened_at, 'localtime') WHERE opened_at IS NOT NULL")
                cursor.execute("UPDATE shifts SET closed_at = datetime(closed_at, 'localtime') WHERE closed_at IS NOT NULL AND closed_at NOT LIKE '%23:59:59'")
                cursor.execute("UPDATE expenses SET expense_date = datetime(expense_date, 'localtime') WHERE expense_date IS NOT NULL")
                cursor.execute("UPDATE purchases SET purchase_date = datetime(purchase_date, 'localtime') WHERE purchase_date IS NOT NULL")
                cursor.execute("UPDATE wishes SET requested_at = datetime(requested_at, 'localtime') WHERE requested_at IS NOT NULL")
                cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('time_synced_to_localtime', '1')")
    except Exception as e:
        print(f"Time migration skipped: {e}")

    # Initial purchases migration
    cursor.execute("""
        SELECT p.id, p.stock, p.cost_price, p.supplier, p.created_at 
        FROM products p
        WHERE NOT EXISTS (
            SELECT 1 FROM purchases pu WHERE pu.product_id = p.id
        )
    """)
    missing_purchases = [dict(row) for row in cursor.fetchall()]
    for prod in missing_purchases:
        cursor.execute("""
            INSERT INTO purchases (product_id, quantity, purchase_price, supplier, status, purchase_date)
            VALUES (?, ?, ?, ?, 'paid', ?)
        """, (prod['id'], prod['stock'], prod['cost_price'] or 0.0, prod['supplier'] or 'Не указан', prod['created_at']))

    try:
        cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_migrations_complete', '1')")
    except Exception:
        pass

    conn.commit()
    conn.close()


# Ensure database is initialized on import if configured
try:
    if is_mysql_configured():
        init_db()
except Exception as e:
    import traceback
    err_log = os.path.join(app_data_dir, 'startup_error.log')
    with open(err_log, 'w', encoding='utf-8') as f:
        traceback.print_exc(file=f)
    try:
        show_windows_messagebox("Ошибка базы данных", f"Не удалось инициализировать базу данных:\n{str(e)}\n\nПодробности в {err_log}", is_error=True)
    except Exception:
        pass
    sys.exit(1)


@app.route('/')
def index():
    return render_template('index.html')

# --- AUTH ENDPOINTS ---

@app.route('/api/auth/status', methods=['GET'])
def auth_status():
    global _cached_setup_complete
    if _cached_setup_complete is None:
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM settings WHERE key = 'owner_password'")
            row = cursor.fetchone()
            conn.close()
            _cached_setup_complete = (row is not None and row[0] != '')
        except Exception:
            _cached_setup_complete = False
    
    return jsonify({
        "setup_complete": _cached_setup_complete,
        "logged_in": session.get('owner_logged_in', False)
    })

@app.route('/api/auth/setup', methods=['POST'])
def auth_setup():
    global _cached_setup_complete, _cached_owner_password_hash
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM settings WHERE key = 'owner_password'")
    row = cursor.fetchone()
    
    if row is not None and row[0] != '':
        conn.close()
        _cached_setup_complete = True
        return jsonify({"success": False, "message": "Пароль уже настроен"}), 400
        
    data = request.json or {}
    password = data.get('password', '').strip()
    if len(password) < 4:
        conn.close()
        return jsonify({"success": False, "message": "Пароль должен содержать минимум 4 символа"}), 400
        
    hashed = hash_password(password)
    cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('owner_password', ?)", (hashed,))

    conn.commit()
    conn.close()
    
    _cached_setup_complete = True
    _cached_owner_password_hash = hashed
    session['owner_logged_in'] = True
    return jsonify({"success": True, "message": "Пароль успешно установлен"})

@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    global _cached_owner_password_hash, _cached_setup_complete
    data = request.json or {}
    password = data.get('password', '').strip()
    
    # Check RAM cache first for 0.01ms instant authentication
    if _cached_owner_password_hash is None:
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM settings WHERE key = 'owner_password'")
            row = cursor.fetchone()
            conn.close()
            if row and row[0]:
                _cached_owner_password_hash = row[0]
                _cached_setup_complete = True
        except Exception as e:
            print(f"Error reading owner password: {e}")
            
    if not _cached_owner_password_hash:
        return jsonify({"success": False, "message": "Пароль еще не настроен. Пожалуйста, выполните настройку."}), 400
        
    hashed_input = hash_password(password)
    if hashed_input == _cached_owner_password_hash:
        session['owner_logged_in'] = True
        return jsonify({"success": True, "message": "Вход выполнен успешно"})
    else:
        return jsonify({"success": False, "message": "Неверный пароль"}), 401

@app.route('/api/auth/logout', methods=['POST'])
def auth_logout():
    session.pop('owner_logged_in', None)
    return jsonify({"success": True})

@app.route('/api/auth/change_owner_password', methods=['POST'])
def change_owner_password():
    global _cached_owner_password_hash
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    data = request.json or {}
    old_password = data.get('old_password', '').strip()
    new_password = data.get('new_password', '').strip()
    confirm_password = data.get('confirm_password', '').strip()
    
    if not old_password or not new_password or not confirm_password:
        return jsonify({"success": False, "message": "Все поля обязательны"}), 400
        
    if new_password != confirm_password:
        return jsonify({"success": False, "message": "Новые пароли не совпадают"}), 400
        
    if len(new_password) < 4:
        return jsonify({"success": False, "message": "Новый пароль должен содержать минимум 4 символа"}), 400
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM settings WHERE key = 'owner_password'")
    r = cursor.fetchone()
    current_hash = r[0] if r else None
    
    if not current_hash or hash_password(old_password) != current_hash:
        conn.close()
        return jsonify({"success": False, "message": "Неверный текущий пароль владельца"}), 400
        
    new_hash = hash_password(new_password)
    cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('owner_password', ?)", (new_hash,))

    conn.commit()
    conn.close()
    
    _cached_owner_password_hash = new_hash
    return jsonify({"success": True, "message": "Пароль владельца успешно обновлен"})

@app.route('/api/cashiers', methods=['GET'])
def get_cashiers():
    global _cached_cashiers, _cached_cashiers_map
    if _cached_cashiers is not None:
        return jsonify(_cached_cashiers)
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, name, email, password FROM cashiers ORDER BY name ASC")
    rows = cursor.fetchall()
    conn.close()
    
    c_list = []
    c_map = {}
    for r in rows:
        d = dict(r)
        c_map[int(d['id'])] = d
        c_list.append({"id": d['id'], "name": d['name'], "email": d['email']})
        
    _cached_cashiers = c_list
    _cached_cashiers_map = c_map
    return jsonify(_cached_cashiers)

@app.route('/api/cashiers', methods=['POST'])
def add_cashier():
    global _cached_cashiers, _cached_cashiers_map
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    data = request.json or {}
    name = data.get('name', '').strip()
    email = data.get('email', '').strip()
    password = data.get('password', '').strip()
    
    if not name or not email or not password:
        return jsonify({"success": False, "message": "Все поля обязательны"}), 400
        
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        hashed_password = hash_password(password)
        cursor.execute("INSERT INTO cashiers (name, email, password) VALUES (?, ?, ?)", (name, email, hashed_password))
        conn.commit()
    except (sqlite3.IntegrityError, Exception) as ie:
        conn.close()
        return jsonify({"success": False, "message": "Кассир с таким Email уже зарегистрирован"}), 400
    conn.close()
    
    _cached_cashiers = None
    _cached_cashiers_map = None
    return jsonify({"success": True, "message": "Кассир успешно добавлен"})

@app.route('/api/cashiers/<int:cashier_id>', methods=['DELETE'])
def delete_cashier(cashier_id):
    global _cached_cashiers, _cached_cashiers_map
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM cashiers WHERE id = ?", (cashier_id,))

    conn.commit()
    conn.close()
    
    _cached_cashiers = None
    _cached_cashiers_map = None
    return jsonify({"success": True, "message": "Кассир успешно удален"})

@app.route('/api/auth/cashier_login', methods=['POST'])
def cashier_login():
    global _cached_cashiers_map
    data = request.json or {}
    cashier_id = data.get('cashier_id')
    password = data.get('password', '').strip()
    
    if not cashier_id or not password:
        return jsonify({"success": False, "message": "Не выбран кассир или не введен пароль"}), 400
        
    try:
        cid = int(cashier_id)
    except (ValueError, TypeError):
        cid = None
        
    cashier_row = None
    # Check RAM cache first for 0.01ms instant cashier validation
    if _cached_cashiers_map and cid in _cached_cashiers_map:
        cashier_row = _cached_cashiers_map[cid]
    else:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, email, password FROM cashiers WHERE id = ?", (cashier_id,))
        r = cursor.fetchone()
        conn.close()
        if r:
            cashier_row = dict(r)
            if _cached_cashiers_map is None:
                _cached_cashiers_map = {}
            if cid:
                _cached_cashiers_map[cid] = cashier_row
            
    if not cashier_row:
        return jsonify({"success": False, "message": "Кассир не найден"}), 404
        
    hashed_input = hash_password(password)
    if hashed_input == cashier_row['password']:
        session['cashier_logged_in'] = True
        session['cashier_name'] = cashier_row['name']
        session['cashier_email'] = cashier_row['email']
        return jsonify({"success": True, "message": f"Добро пожаловать, {cashier_row['name']}!"})
    else:
        return jsonify({"success": False, "message": "Неверный пароль / PIN-код"}), 401

# --- FINANCE (EXPENSES & PURCHASES) ENDPOINTS ---

@app.route('/api/expenses', methods=['GET'])
def get_expenses():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM expenses ORDER BY expense_date DESC")
    rows = cursor.fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route('/api/expenses', methods=['POST'])
def add_expense():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    data = request.json or {}
    try:
        amount = float(data.get('amount', 0.0))
        if amount <= 0:
            return jsonify({"success": False, "message": "Сумма расхода должна быть больше нуля"}), 400
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "Некорректная сумма расхода"}), 400
        
    category = data.get('category', '').strip()
    description = data.get('description', '').strip()
    
    if not category:
        return jsonify({"success": False, "message": "Категория обязательна"}), 400
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO expenses (amount, category, description) VALUES (?, ?, ?)", (amount, category, description))

    conn.commit()
    conn.close()
    return jsonify({"success": True, "message": "Расход успешно записан"})

@app.route('/api/expenses/<int:expense_id>', methods=['DELETE'])
def delete_expense(expense_id):
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))

    conn.commit()
    conn.close()
    return jsonify({"success": True, "message": "Расход успешно удален"})

@app.route('/api/purchases', methods=['GET'])
def get_purchases():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT p.*, COALESCE(pr.name, '[Удаленный товар (ID ' || p.product_id || ')]') as product_name
        FROM purchases p
        LEFT JOIN products pr ON p.product_id = pr.id
        ORDER BY p.purchase_date DESC
    ''')
    rows = cursor.fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route('/api/purchases/<int:purchase_id>/pay', methods=['POST'])
def pay_purchase_debt(purchase_id):
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE purchases SET status = 'paid' WHERE id = ? AND status = 'debt'", (purchase_id,))

    conn.commit()
    conn.close()
    return jsonify({"success": True, "message": "Долг перед поставщиком успешно закрыт"})

# --- VOICE ASSISTANT ENDPOINT ---

RU_NUMBERS = {
    "ноль": 0, "один": 1, "два": 2, "три": 3, "четыре": 4, "пять": 5, "шесть": 6, "семь": 7, "восемь": 8, "девять": 9,
    "десять": 10, "одиннадцать": 11, "двенадцать": 12, "тринадцать": 13, "четырнадцать": 14, "пятнадцать": 15,
    "шестнадцать": 16, "семнадцать": 17, "восемнадцать": 18, "девятнадцать": 19,
    "двадцать": 20, "тридцать": 30, "сорок": 40, "пятьдесят": 50, "шестьдесят": 60, "семьдесят": 70, "восемьдесят": 80, "девяносто": 90,
    "сто": 100, "двести": 200, "триста": 300, "четыреста": 400, "пятьсот": 500, "шестьсот": 600, "семьсот": 700, "восемьсот": 800, "девятьсот": 900,
    "тысяча": 1000, "тысячи": 1000, "тысяч": 1000, "тыс": 1000,
    "миллион": 1000000, "миллиона": 1000000, "миллионов": 1000000, "млн": 1000000,
}

def text_to_number(words):
    total = 0
    current = 0
    for word in words:
        word = word.lower().strip().replace(",", "").replace(".", "")
        if word.isdigit():
            val = int(word)
            if val in [1000, 1000000]:
                current = (current or 1) * val
            else:
                current += val
        elif word in RU_NUMBERS:
            val = RU_NUMBERS[word]
            if val in [1000, 1000000]:
                current = (current or 1) * val
                total += current
                current = 0
            else:
                current += val
        else:
            break
    total += current
    return total

@app.route('/api/voice-command', methods=['POST'])
def process_voice_command():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    data = request.json or {}
    text = data.get('text', '').lower().strip()
    
    if not text:
        return jsonify({"success": False, "message": "Пустой текст команды"})
        
    prefixes = ["добавить товар", "добавь товар", "создай товар"]
    matched_prefix = None
    for p in prefixes:
        if text.startswith(p):
            matched_prefix = p
            break
            
    if not matched_prefix:
        # Navigation and stats commands
        if "склад" in text:
            return jsonify({"success": True, "action": "navigate", "target": "tab-warehouse-list", "speech": "Открываю склад"})
        elif "добавление" in text or "поступление" in text:
            return jsonify({"success": True, "action": "navigate", "target": "tab-warehouse", "speech": "Открываю добавление товаров"})
        elif "аналитик" in text or "отчет" in text:
            return jsonify({"success": True, "action": "navigate", "target": "tab-analytics", "speech": "Открываю аналитику"})
        elif "график" in text:
            return jsonify({"success": True, "action": "navigate", "target": "tab-charts", "speech": "Открываю графики"})
        elif "выручк" in text or "заработал" in text:
            conn = get_db_connection()
            row = conn.execute("SELECT SUM(total_price) as rev FROM sales").fetchone()
            rev = row['rev'] if row['rev'] else 0
            conn.close()
            return jsonify({"success": True, "action": "get_revenue", "speech": f"Общая выручка за всё время составляет {int(round(rev))} сум."})
        else:
            return jsonify({"success": False, "action": "unknown", "speech": f"Я услышала: {text}. К сожалению, я не знаю такой команды."})
            
    # Add product command
    phrase = text[len(matched_prefix):].strip()
    words = phrase.split()
    
    price = 0
    cost_price = 0.0
    stock = 1
    supplier = ""
    type_val = ""
    
    cleaned_name_words = []
    
    i = 0
    while i < len(words):
        word = words[i]
        if word in ["цена", "за"]:
            num_words = []
            j = i + 1
            while j < len(words) and (words[j] in RU_NUMBERS or words[j].isdigit() or words[j].replace(",", "").replace(".", "").isdigit()):
                num_words.append(words[j])
                j += 1
            if num_words:
                price = text_to_number(num_words)
                i = j - 1
            i += 1
            continue
        elif word in ["себестоимость", "себестоимости", "закупка", "закупочная"]:
            num_words = []
            j = i + 1
            while j < len(words) and (words[j] in RU_NUMBERS or words[j].isdigit() or words[j].replace(",", "").replace(".", "").isdigit()):
                num_words.append(words[j])
                j += 1
            if num_words:
                cost_price = float(text_to_number(num_words))
                i = j - 1
            i += 1
            continue
        elif word in ["количество", "остаток", "кол-во", "колво"]:
            num_words = []
            j = i + 1
            while j < len(words) and (words[j] in RU_NUMBERS or words[j].isdigit() or words[j].replace(",", "").replace(".", "").isdigit()):
                num_words.append(words[j])
                j += 1
            if num_words:
                stock = int(text_to_number(num_words))
                i = j - 1
            i += 1
            continue
        elif word in ["поставщик", "поставщика", "поставщиком"]:
            supp_words = []
            j = i + 1
            keywords = ["цена", "за", "себестоимость", "закупка", "количество", "остаток", "поставщик", "тип", "категория"]
            while j < len(words) and words[j] not in keywords:
                supp_words.append(words[j])
                j += 1
            if supp_words:
                supplier = " ".join(supp_words)
                i = j - 1
            i += 1
            continue
        elif word in ["тип", "категория", "категории"]:
            type_words = []
            j = i + 1
            keywords = ["цена", "за", "себестоимость", "закупка", "количество", "остаток", "поставщик", "тип", "категория"]
            while j < len(words) and words[j] not in keywords:
                type_words.append(words[j])
                j += 1
            if type_words:
                type_val = " ".join(type_words)
                i = j - 1
            i += 1
            continue
        else:
            if word in ["рублей", "рублей", "руб", "сум", "штук", "штуки", "шт"]:
                pass
            else:
                cleaned_name_words.append(word)
        i += 1
        
    product_phrase = " ".join(cleaned_name_words).strip()
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Load known keywords to intelligently split the product phrase
    known_types = [r['type'] for r in cursor.execute("SELECT DISTINCT type FROM products WHERE is_deleted = 0 AND type IS NOT NULL AND type != ''").fetchall()]
    known_brands = [r['brand'] for r in cursor.execute("SELECT DISTINCT brand FROM products WHERE is_deleted = 0 AND brand IS NOT NULL AND brand != ''").fetchall()]
    known_models = [r['model'] for r in cursor.execute("SELECT DISTINCT model FROM products WHERE is_deleted = 0 AND model IS NOT NULL AND model != ''").fetchall()]
    known_suffixes = [r['unique_suffix'] for r in cursor.execute("SELECT DISTINCT unique_suffix FROM products WHERE is_deleted = 0 AND unique_suffix IS NOT NULL AND unique_suffix != ''").fetchall()]
    
    known_types.sort(key=len, reverse=True)
    known_brands.sort(key=len, reverse=True)
    known_models.sort(key=len, reverse=True)
    known_suffixes.sort(key=len, reverse=True)
    
    matched_type = type_val
    matched_brand = ""
    matched_model = ""
    matched_suffix = ""
    
    remaining = product_phrase
    
    # 1. Match type
    if not matched_type:
        for t in known_types:
            if remaining.startswith(t.lower()):
                matched_type = t
                remaining = remaining[len(t):].strip()
                break
                
    # 2. Match brand
    for b in known_brands:
        if remaining.startswith(b.lower()):
            matched_brand = b
            remaining = remaining[len(b):].strip()
            break
            
    # 3. Match model
    for m in known_models:
        if remaining.startswith(m.lower()):
            matched_model = m
            remaining = remaining[len(m):].strip()
            break
            
    # 4. Match suffix
    for s in known_suffixes:
        if remaining.startswith(s.lower()):
            matched_suffix = s
            remaining = remaining[len(s):].strip()
            break
            
    # If we didn't match some parts but have remaining text, fallback split
    if not matched_type and remaining:
        words_rem = remaining.split()
        matched_type = words_rem[0].capitalize()
        remaining = " ".join(words_rem[1:])
        
    if not matched_brand and remaining:
        words_rem = remaining.split()
        matched_brand = words_rem[0].capitalize()
        remaining = " ".join(words_rem[1:])
        
    if remaining:
        words_rem = remaining.split()
        if not matched_model:
            if len(words_rem) > 1:
                matched_model = " ".join(words_rem[:-1])
                matched_suffix = words_rem[-1]
            else:
                matched_model = words_rem[0]
        else:
            matched_suffix = remaining
            
    # Normalize strings
    matched_type = matched_type.strip()
    matched_brand = matched_brand.strip()
    matched_model = matched_model.strip()
    matched_suffix = matched_suffix.strip()
    
    # Calculate name
    pname = " ".join(filter(None, [matched_type, matched_brand, matched_model, matched_suffix])).strip()
    
    if not pname:
        conn.close()
        return jsonify({"success": False, "message": "Не удалось распознать название товара"})
        
    # Check duplicate
    existing = cursor.execute(
        "SELECT id, stock FROM products WHERE is_deleted = 0 AND LOWER(type) = ? AND LOWER(brand) = ? AND LOWER(model) = ? AND LOWER(unique_suffix) = ?",
        (matched_type.lower(), matched_brand.lower(), matched_model.lower(), matched_suffix.lower())
    ).fetchone()
    
    if existing:
        new_stock = existing["stock"] + stock
        set_clauses = ["stock = ?"]
        params = [new_stock]
        if price > 0:
            set_clauses.append("price = ?")
            params.append(price)
        if cost_price > 0:
            set_clauses.append("cost_price = ?")
            params.append(cost_price)
        if supplier:
            set_clauses.append("supplier = ?")
            params.append(supplier)
            
        params.append(existing["id"])
        cursor.execute(f"UPDATE products SET {', '.join(set_clauses)} WHERE id = ?", tuple(params))
        conn.commit()
        
        updated_product = cursor.execute("SELECT id, name, price, stock, cost_price, supplier, type, brand, model, unique_suffix as suffix, barcode FROM products WHERE id = ?", (existing["id"],)).fetchone()
        prod_dict = dict(updated_product)
        conn.close()
        return jsonify({
            "success": True,
            "action": "add_product",
            "product": prod_dict,
            "speech": f"Товар {pname} уже существует. Пополнено на {stock} шт. Итого: {new_stock} шт."
        })
    else:
        # Create new
        last_p = cursor.execute("SELECT barcode FROM products ORDER BY id DESC LIMIT 1").fetchone()
        if last_p and last_p['barcode'].isdigit():
            next_bc = str(int(last_p['barcode']) + 1)
        else:
            next_bc = "1000"
            
        cursor.execute("INSERT INTO products (name, price, stock, cost_price, supplier, type, brand, model, unique_suffix, barcode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                       (pname, price, stock, cost_price, supplier, matched_type, matched_brand, matched_model, matched_suffix, next_bc))
        conn.commit()
    if stock > 0:
        cursor.execute("""
            INSERT INTO purchases (product_id, quantity, purchase_price, supplier, status, purchase_date)
            VALUES (?, ?, ?, ?, 'paid', datetime('now', 'localtime'))
        """, (new_id, stock, cost_price or 0.0, supplier or 'Не указан'))
        conn.commit()
        
        new_id = cursor.lastrowid
        new_product = cursor.execute("SELECT id, name, price, stock, cost_price, supplier, type, brand, model, unique_suffix as suffix, barcode FROM products WHERE id = ?", (new_id,)).fetchone()
        prod_dict = dict(new_product)
        conn.close()
        
        return jsonify({
            "success": True,
            "action": "add_product",
            "product": prod_dict,
            "speech": f"Добавлен товар: {pname}. Количество: {stock} штук."
        })

# --- PRODUCTS ENDPOINTS ---

@app.route('/api/products', methods=['GET'])
def get_products():
    etag = get_catalog_version()
    if_none_match = request.headers.get('If-None-Match')
    if if_none_match and if_none_match.strip('"') == etag:
        # 304 Not Modified: 0 bytes transferred over network!
        resp = make_response('', 304)
        resp.headers['ETag'] = f'"{etag}"'
        resp.headers['Cache-Control'] = 'no-cache'
        return resp

    products, _, _ = get_or_load_catalog()
    resp = jsonify(products)
    resp.headers['ETag'] = f'"{etag}"'
    resp.headers['Cache-Control'] = 'no-cache'
    return resp

@app.route('/api/products', methods=['POST'])
def add_product():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    data = request.json
    name = data.get('name', '').strip()
    price = data.get('price')
    stock = data.get('stock', 0)
    cost_price = data.get('cost_price', 0.0)
    supplier = data.get('supplier', '').strip()
    type_val = data.get('type', '').strip()
    brand = data.get('brand', '').strip()
    model = data.get('model', '').strip()
    suffix = data.get('suffix', '').strip()
    if not suffix:
        suffix = data.get('unique_suffix', '').strip()
    further_spec = data.get('further_spec', '').strip()
    note = data.get('note', '').strip()
        
    if not name:
        name = " ".join(filter(None, [type_val, brand, model, suffix, further_spec])).strip()
        
    if not name:
        return jsonify({"success": False, "message": "Название товара обязательно (заполните хотя бы фирму или модель)"}), 400
    try:
        price = int(round(float(price)))
        if price < 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "Некорректная цена продажи товара"}), 400
        
    try:
        cost_price = int(round(float(cost_price))) if cost_price is not None else 0
        if cost_price < 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "Некорректная себестоимость товара"}), 400

    try:
        stock = int(stock)
        if stock < 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "Некорректное количество на складе"}), 400

    barcode_input = data.get('barcode', '').strip()

    conn = get_db_connection()
    cursor = conn.cursor()
    
    if barcode_input:
        new_barcodes = [b.strip() for b in barcode_input.split(',') if b.strip()]
        cursor.execute("SELECT id, name, barcode FROM products WHERE is_deleted = 0")
        all_products = cursor.fetchall()
        for prod in all_products:
            prod_barcodes = [b.strip() for b in (prod['barcode'] or '').split(',') if b.strip()]
            for nb in new_barcodes:
                if nb in prod_barcodes:
                    conn.close()
                    return jsonify({
                        "success": False,
                        "is_duplicate": True,
                        "product_id": prod['id'],
                        "product_name": prod['name'],
                        "message": f"Штрихкод '{nb}' уже зарегистрирован за товаром '{prod['name']}'."
                    }), 400

    # Check for duplicate by attributes (type, brand, model, unique_suffix, further_spec, note)
    cursor.execute(
        "SELECT id, name, stock FROM products WHERE is_deleted = 0 AND IFNULL(LOWER(type), '') = LOWER(?) AND IFNULL(LOWER(brand), '') = LOWER(?) AND IFNULL(LOWER(model), '') = LOWER(?) AND IFNULL(LOWER(unique_suffix), '') = LOWER(?) AND IFNULL(LOWER(further_spec), '') = LOWER(?) AND IFNULL(LOWER(note), '') = LOWER(?)",
        (type_val, brand, model, suffix, further_spec, note)
    )
    existing_dup = cursor.fetchone()
    if existing_dup:
        conn.close()
        return jsonify({
            "success": False,
            "is_duplicate": True,
            "product_id": existing_dup['id'],
            "product_name": existing_dup['name'],
            "message": f"Товар '{existing_dup['name']}' уже существует на складе."
        }), 400

    try:
        # Insert product with temporary NULL barcode to avoid UNIQUE constraint violations on empty strings
        cursor.execute(
            "INSERT INTO products (name, price, stock, cost_price, supplier, type, brand, model, unique_suffix, further_spec, note, barcode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
            (name, price, stock, cost_price, supplier, type_val, brand, model, suffix, further_spec, note)
        )
        rowid = cursor.lastrowid
        
        final_barcode = barcode_input
        if not final_barcode:
            temp_id = rowid
            while True:
                candidate = f"{1000 + temp_id}"
                cursor.execute("SELECT id FROM products WHERE is_deleted = 0 AND (barcode = ? OR instr(barcode, ?))", (candidate, candidate))
                if not cursor.fetchone():
                    final_barcode = candidate
                    break
                temp_id += 1
                
        cursor.execute("UPDATE products SET barcode = ? WHERE id = ?", (final_barcode, rowid))
        conn.commit()
        if stock > 0:
            cursor.execute("""
                INSERT INTO purchases (product_id, quantity, purchase_price, supplier, status, purchase_date)
                VALUES (?, ?, ?, ?, 'paid', datetime('now', 'localtime'))
            """, (rowid, stock, cost_price or 0.0, supplier or 'Не указан'))
            conn.commit()
        
        # Retrieve the saved product
        cursor.execute("SELECT * FROM products WHERE id = ?", (rowid,))
        product = dict(cursor.fetchone())
        conn.close()
        invalidate_catalog_cache()
        return jsonify({"success": True, "product": product})
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        conn.close()
        return jsonify({"success": False, "message": f"Ошибка добавления: {str(e)}"}), 500

@app.route('/api/products/<barcode>', methods=['GET'])
def get_product_by_barcode(barcode):
    matched_prod = find_product_by_barcode(barcode)
    if matched_prod:
        return jsonify({"success": True, "product": dict(matched_prod)})
    else:
        return jsonify({"success": False, "message": "Товар не найден"}), 404

@app.route('/api/products/<int:product_id>', methods=['PUT'])
def update_product(product_id):
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    data = request.json
    name = data.get('name', '').strip()
    price = data.get('price')
    stock = data.get('stock')
    cost_price = data.get('cost_price', 0.0)
    supplier = data.get('supplier', '').strip()
    type_val = data.get('type', '').strip()
    brand = data.get('brand', '').strip()
    model = data.get('model', '').strip()
    suffix = data.get('suffix', '').strip()
    if not suffix:
        suffix = data.get('unique_suffix', '').strip()
    further_spec = data.get('further_spec', '').strip()
    note = data.get('note', '').strip()
    
    if not name:
        name = " ".join(filter(None, [type_val, brand, model, suffix, further_spec])).strip()
        
    if not name:
        return jsonify({"success": False, "message": "Название товара обязательно"}), 400
    try:
        price = int(round(float(price)))
        if price < 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "Некорректная цена товара"}), 400
        
    try:
        cost_price = int(round(float(cost_price))) if cost_price is not None else 0
        if cost_price < 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "Некорректная себестоимость товара"}), 400
        
    try:
        stock = int(stock)
        if stock < 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "Некорректное количество"}), 400

    barcode_input = data.get('barcode', '').strip()

    conn = get_db_connection()
    cursor = conn.cursor()
    
    if barcode_input:
        new_barcodes = [b.strip() for b in barcode_input.split(',') if b.strip()]
        cursor.execute("SELECT id, name, barcode FROM products WHERE is_deleted = 0 AND id != ?", (product_id,))
        other_products = cursor.fetchall()
        for prod in other_products:
            prod_barcodes = [b.strip() for b in (prod['barcode'] or '').split(',') if b.strip()]
            for nb in new_barcodes:
                if nb in prod_barcodes:
                    conn.close()
                    return jsonify({
                        "success": False,
                        "is_duplicate": True,
                        "product_id": prod['id'],
                        "product_name": prod['name'],
                        "message": f"Штрихкод '{nb}' уже зарегистрирован за другим товаром '{prod['name']}'."
                    }), 400

    final_barcode = barcode_input
    if not final_barcode:
        temp_id = product_id
        while True:
            candidate = f"{1000 + temp_id}"
            cursor.execute("SELECT id FROM products WHERE is_deleted = 0 AND (barcode = ? OR instr(barcode, ?)) AND id != ?", (candidate, candidate, product_id))
            if not cursor.fetchone():
                final_barcode = candidate
                break
            temp_id += 1

    cursor.execute("UPDATE products SET name = ?, price = ?, stock = ?, cost_price = ?, supplier = ?, type = ?, brand = ?, model = ?, unique_suffix = ?, further_spec = ?, note = ?, barcode = ? WHERE id = ?", 
                   (name, price, stock, cost_price, supplier, type_val, brand, model, suffix, further_spec, note, final_barcode, product_id))

    conn.commit()
    conn.close()
    invalidate_catalog_cache()
    return jsonify({"success": True, "message": "Товар обновлен"})

@app.route('/api/products/mass-update', methods=['POST'])
def mass_update_products():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    data = request.json or {}
    product_ids = data.get('ids', [])
    
    if not product_ids:
        return jsonify({"success": False, "message": "Не выбраны товары для обновления!"})
        
    # Fields to update
    update_data = {}
    if 'type' in data and data['type']:
        update_data['type'] = str(data['type']).strip()
    if 'brand' in data and data['brand']:
        update_data['brand'] = str(data['brand']).strip()
    if 'model' in data and data['model']:
        update_data['model'] = str(data['model']).strip()
    if 'suffix' in data and data['suffix']:
        update_data['unique_suffix'] = str(data['suffix']).strip()
    if 'further_spec' in data and data['further_spec']:
        update_data['further_spec'] = str(data['further_spec']).strip()
    if 'supplier' in data and data['supplier']:
        update_data['supplier'] = str(data['supplier']).strip()
    if 'note' in data and data['note']:
        update_data['note'] = str(data['note']).strip()
        
    if 'price' in data and data['price'] is not None and data['price'] != "":
        try:
            update_data['price'] = float(data['price'])
        except ValueError:
            pass
    if 'cost_price' in data and data['cost_price'] is not None and data['cost_price'] != "":
        try:
            update_data['cost_price'] = float(data['cost_price'])
        except ValueError:
            pass
            
    stock_mode = data.get('stock_mode', 'keep') # keep, set, add, sub
    stock_val = data.get('stock_val', 0)
    
    conn = get_db_connection()
    try:
        # Loop over selected IDs and apply modifications
        for pid in product_ids:
            row = conn.execute("SELECT type, brand, model, unique_suffix, further_spec, name, stock FROM products WHERE id = ?", (pid,)).fetchone()
            if not row:
                continue
                
            temp_update = update_data.copy()
            
            # Stock logic
            if stock_mode == 'set':
                temp_update['stock'] = int(stock_val)
            elif stock_mode == 'add':
                temp_update['stock'] = int(row['stock']) + int(stock_val)
            elif stock_mode == 'sub':
                temp_update['stock'] = max(0, int(row['stock']) - int(stock_val))
                
            # Composite name recalculation
            type_val = temp_update.get('type', row['type'] or '')
            brand_val = temp_update.get('brand', row['brand'] or '')
            model_val = temp_update.get('model', row['model'] or '')
            suffix_val = temp_update.get('unique_suffix', row['unique_suffix'] or '')
            further_spec_val = temp_update.get('further_spec', row['further_spec'] or '')
            
            new_name = " ".join(filter(None, [type_val, brand_val, model_val, suffix_val, further_spec_val])).strip()
            if not new_name:
                new_name = row['name']
            temp_update['name'] = new_name
            
            set_clause = []
            params = []
            for k, v in temp_update.items():
                set_clause.append(f"{k} = ?")
                params.append(v)
                
            if set_clause:
                params.append(pid)
                conn.execute(f"UPDATE products SET {', '.join(set_clause)} WHERE id = ?", tuple(params))
                
        conn.commit()
        invalidate_catalog_cache()
        return jsonify({"success": True})
    except Exception as e:
        conn.rollback()
        return jsonify({"success": False, "message": f"Ошибка БД: {str(e)}"})
    finally:
        conn.close()

@app.route('/api/products/<int:product_id>', methods=['DELETE'])
def delete_product(product_id):
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM products WHERE id = ?", (product_id,))

    conn.commit()
    conn.close()
    invalidate_catalog_cache()
    return jsonify({"success": True, "message": "Товар удален"})

@app.route('/api/products/<int:product_id>/restock', methods=['POST'])
def restock_product(product_id):
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    data = request.json or {}
    try:
        quantity = int(data.get('quantity', 0))
        if quantity <= 0:
            return jsonify({"success": False, "message": "Количество должно быть больше 0"}), 400
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "Некорректное количество"}), 400
        
    try:
        purchase_price = float(data.get('purchase_price', 0.0))
        if purchase_price < 0:
            return jsonify({"success": False, "message": "Закупочная цена не может быть отрицательной"}), 400
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "Некорректная закупочная цена"}), 400
        
    supplier = data.get('supplier', '').strip()
    status = data.get('status', 'paid').strip()
    if status not in ['paid', 'debt']:
        status = 'paid'
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Verify product exists
    cursor.execute("SELECT * FROM products WHERE id = ?", (product_id,))
    product_row = cursor.fetchone()
    if not product_row:
        conn.close()
        return jsonify({"success": False, "message": "Товар не найден"}), 404
        
    current_stock = product_row['stock'] or 0
    current_cost_price = product_row['cost_price'] or 0.0
    
    # Update cost price using weighted average if stock > 0, otherwise set directly
    if current_stock > 0:
        new_cost_price = ((current_stock * current_cost_price) + (quantity * purchase_price)) / (current_stock + quantity)
    else:
        new_cost_price = purchase_price
        
    # Round new cost price to nearest integer for currency consistency
    new_cost_price = int(round(new_cost_price))
    
    if not supplier:
        supplier = product_row['supplier'] or "Неизвестный"
        
    # Increment stock and update cost price and supplier
    cursor.execute(
        "UPDATE products SET stock = stock + ?, cost_price = ?, supplier = ? WHERE id = ?",
        (quantity, new_cost_price, supplier, product_id)
    )
    
    # Record the purchase history
    cursor.execute(
        "INSERT INTO purchases (product_id, quantity, purchase_price, supplier, status) VALUES (?, ?, ?, ?, ?)",
        (product_id, quantity, purchase_price, supplier, status)
    )
    
    # Fetch updated product row
    cursor.execute("SELECT * FROM products WHERE id = ?", (product_id,))
    updated_product = dict(cursor.fetchone())

    conn.commit()
    conn.close()
    invalidate_catalog_cache()
    
    return jsonify({
        "success": True,
        "message": f"Товар успешно пополнен на {quantity} шт.",
        "product": updated_product
    })

@app.route('/api/audit/save-mismatches', methods=['POST'])
def save_audit_mismatches():
    data = request.json or {}
    adjustments = data.get('adjustments', [])
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        inserted_count = 0
        for adj in adjustments:
            product_id = adj.get('id')
            expected = adj.get('expected', 0)
            actual = adj.get('actual', 0)
            diff = actual - expected
            
            if diff != 0:
                # Add to discrepancies
                cursor.execute(
                    "INSERT INTO discrepancies (product_id, expected_stock, actual_stock, difference) VALUES (?, ?, ?, ?)",
                    (product_id, expected, actual, diff)
                )
                inserted_count += 1
                
        conn.commit()
        conn.close()
        
        # Trigger GDrive backup report sync
        try:
            upload_report_to_gdrive()
        except Exception as e:
            print(f"Error syncing report after mismatch log: {e}")
            
        return jsonify({"success": True, "message": f"Записано {inserted_count} расхождений в список несоответствий!"})
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({"success": False, "message": f"Ошибка: {str(e)}"}), 500

@app.route('/api/discrepancies', methods=['GET'])
def get_discrepancies():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT d.*, p.name as product_name, p.barcode as product_barcode
        FROM discrepancies d
        JOIN products p ON d.product_id = p.id
        ORDER BY d.id DESC
    ''')
    rows = cursor.fetchall()
    conn.close()
    
    mismatches = []
    for r in rows:
        mismatches.append(dict(r))
    return jsonify({"success": True, "discrepancies": mismatches})

@app.route('/api/discrepancies/<int:item_id>/apply', methods=['POST'])
def apply_discrepancy(item_id):
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    data = request.json or {}
    password = data.get('password', '').strip()
    if not password:
        return jsonify({"success": False, "message": "Пароль владельца обязателен"}), 400
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        # Verify owner password
        cursor.execute("SELECT value FROM settings WHERE key = 'owner_password'")
        row = cursor.fetchone()
        if row is None:
            conn.close()
            return jsonify({"success": False, "message": "Пароль владельца еще не настроен!"}), 400
            
        hashed_input = hash_password(password)
        if hashed_input != row[0]:
            conn.close()
            return jsonify({"success": False, "message": "Неверный пароль владельца!"}), 401
            
        # Get discrepancy info
        cursor.execute("SELECT product_id, actual_stock FROM discrepancies WHERE id = ?", (item_id,))
        disc = cursor.fetchone()
        if not disc:
            conn.close()
            return jsonify({"success": False, "message": "Несоответствие не найдено"}), 404
            
        product_id = disc['product_id']
        actual_stock = disc['actual_stock']
        
        # Update product stock in database
        cursor.execute("UPDATE products SET stock = ? WHERE id = ?", (actual_stock, product_id))
        
        # Delete discrepancy from list
        cursor.execute("DELETE FROM discrepancies WHERE id = ?", (item_id,))
        
        conn.commit()
        conn.close()
        invalidate_catalog_cache()
        
        # Trigger GDrive backup report sync
        try:
            upload_report_to_gdrive()
        except Exception as e:
            print(f"Error syncing report after discrepancy apply: {e}")
            
        return jsonify({"success": True, "message": "Остаток товара успешно обновлен в соответствии со сверкой!"})
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({"success": False, "message": f"Ошибка: {str(e)}"}), 500

@app.route('/api/discrepancies/<int:item_id>', methods=['DELETE'])
def delete_discrepancy(item_id):
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM discrepancies WHERE id = ?", (item_id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": "Несоответствие удалено из списка."})
    except Exception as e:
        conn.close()
        return jsonify({"success": False, "message": f"Ошибка: {str(e)}"}), 500

@app.route('/api/products/<int:product_id>/history', methods=['GET'])
def get_product_history(product_id):
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 1. Fetch product basic info
    cursor.execute("SELECT * FROM products WHERE id = ?", (product_id,))
    prod_row = cursor.fetchone()
    if not prod_row:
        conn.close()
        return jsonify({"success": False, "message": "Товар не найден"}), 404
        
    product = dict(prod_row)
    
    # 2. Fetch purchases (replenishments)
    cursor.execute("""
        SELECT purchase_date, quantity, purchase_price, supplier, status
        FROM purchases
        WHERE product_id = ?
        ORDER BY purchase_date DESC
    """, (product_id,))
    purchase_rows = cursor.fetchall()
    
    # 3. Fetch sales
    cursor.execute("""
        SELECT s.sold_at, s.quantity, s.price_original, s.discount_percent, s.price_final, s.payment_method, sh.id as shift_id
        FROM sales s
        LEFT JOIN shifts sh ON s.shift_id = sh.id
        WHERE s.product_id = ?
        ORDER BY s.sold_at DESC
    """, (product_id,))
    sale_rows = cursor.fetchall()
    
    # 4. Fetch write-offs
    cursor.execute("""
        SELECT created_at, quantity, reason
        FROM write_offs
        WHERE product_id = ?
        ORDER BY created_at DESC
    """, (product_id,))
    write_off_rows = cursor.fetchall()
    
    conn.close()
    
    # Assemble events list
    events = []
    
    # Add product creation event
    if product.get('created_at'):
        events.append({
            "type": "creation",
            "date": product['created_at'],
            "title": "Товар внесен в базу данных",
            "details": f"Начальный остаток: {product.get('stock', 0)} шт., Цена продажи: {product.get('price', 0.0)} сум"
        })
        
    for p in purchase_rows:
        events.append({
            "type": "purchase",
            "date": p['purchase_date'],
            "title": f"Поступление товара (+{p['quantity']} шт.)",
            "details": f"Количество: {p['quantity']} шт., Закуп: {p['purchase_price']} сум, Поставщик: {p['supplier']}, Статус: {'Оплачено' if p['status'] == 'paid' else 'Долг'}"
        })
        
    for s in sale_rows:
        discount_str = f" (Скидка {s['discount_percent']}%)" if s['discount_percent'] > 0 else ""
        payment_str = "Наличные" if s['payment_method'] == 'cash' else ("Карта" if s['payment_method'] == 'card' else "Перевод")
        events.append({
            "type": "sale",
            "date": s['sold_at'],
            "title": f"Продажа товара (-{s['quantity']} шт.) (Смена №{s['shift_id'] or '?'})",
            "details": f"Количество: {s['quantity']} шт., Сумма: {s['price_final']} сум{discount_str}, Оплата: {payment_str}"
        })
        
    for w in write_off_rows:
        events.append({
            "type": "write_off",
            "date": w['created_at'],
            "title": f"Списание товара (-{w['quantity']} шт.)",
            "details": f"Количество: {w['quantity']} шт., Причина: {w['reason']}"
        })
        
    # Sort events by date descending
    events.sort(key=lambda x: x['date'], reverse=True)
    
    return jsonify({
        "success": True,
        "product": product,
        "history": events
    })

@app.route('/api/products/<int:product_id>/defective', methods=['POST'])
def defective_product(product_id):
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    data = request.json or {}
    try:
        quantity = int(data.get('quantity', 0))
        if quantity <= 0:
            return jsonify({"success": False, "message": "Количество должно быть больше 0"}), 400
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "Некорректное количество"}), 400
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Verify product exists
    cursor.execute("SELECT * FROM products WHERE id = ?", (product_id,))
    product_row = cursor.fetchone()
    if not product_row:
        conn.close()
        return jsonify({"success": False, "message": "Товар не найден"}), 404
        
    product = dict(product_row)
    if product['stock'] < quantity:
        conn.close()
        return jsonify({"success": False, "message": f"Недостаточно товара на складе для списания. В наличии: {product['stock']}"}), 400
        
    # Decrement stock
    reason = data.get('reason', 'Брак').strip() or 'Брак'
    cursor.execute("UPDATE products SET stock = stock - ? WHERE id = ?", (quantity, product_id))
    
    # Save write-off details
    cursor.execute("INSERT INTO write_offs (product_id, quantity, reason) VALUES (?, ?, ?)", (product_id, quantity, reason))
    
    # Fetch updated product row
    cursor.execute("SELECT * FROM products WHERE id = ?", (product_id,))
    updated_product = dict(cursor.fetchone())

    conn.commit()
    conn.close()
    invalidate_catalog_cache()
    
    return jsonify({
        "success": True,
        "message": f"Списано {quantity} шт. брака.",
        "product": updated_product
    })



@app.route('/api/products/<int:product_id>/secret-sell', methods=['POST'])
def secret_sell_product(product_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 1. Fetch product
    cursor.execute("SELECT * FROM products WHERE id = ?", (product_id,))
    product_row = cursor.fetchone()
    if not product_row:
        conn.close()
        return jsonify({"success": False, "message": "Товар не найден"}), 404
        
    product = dict(product_row)
    
    # 2. Get latest replenishment date
    cursor.execute("SELECT purchase_date FROM purchases WHERE product_id = ? ORDER BY purchase_date DESC LIMIT 1", (product_id,))
    purch_row = cursor.fetchone()
    
    base_date_str = None
    if purch_row:
        base_date_str = purch_row[0]
    else:
        base_date_str = product.get('created_at')
        
    # Determine sale date (base_date + 1 day)
    import datetime
    sale_date_str = None
    if base_date_str:
        parsed_dt = None
        for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M:%S.%f', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%dT%H:%M:%S.%f'):
            try:
                parsed_dt = datetime.datetime.strptime(base_date_str, fmt)
                break
            except ValueError:
                pass
        if parsed_dt:
            sale_dt = parsed_dt + datetime.timedelta(days=1)
            sale_date_str = sale_dt.strftime('%Y-%m-%d %H:%M:%S')
            
    if not sale_date_str:
        sale_date_str = (datetime.datetime.now() - datetime.timedelta(days=1)).strftime('%Y-%m-%d %H:%M:%S')
        
    # 3. Decrement stock
    new_stock = max(0, product['stock'] - 1)
    cursor.execute("UPDATE products SET stock = ? WHERE id = ?", (new_stock, product_id))
    
    # 4. Insert sale record in sales table
    cursor.execute("""
        INSERT INTO sales (product_id, quantity, price_original, discount_percent, price_final, sold_at, payment_method)
        VALUES (?, 1, ?, 0.0, ?, ?, 'cash')
    """, (product_id, product['price'], product['price'], sale_date_str))
    
    conn.commit()
    conn.close()
    invalidate_catalog_cache()
    
    return jsonify({
        "success": True,
        "message": "Секретная продажа успешно выполнена",
        "sold_at": sale_date_str
    })


# --- SHIFT ENDPOINTS ---

@app.route('/api/shift/active', methods=['GET'])
def get_active_shift():
    global _cached_active_shift, _cached_active_shift_ts
    now = time.time()
    if now - _cached_active_shift_ts < 2.0:
        return jsonify({"success": True, "shift": _cached_active_shift})
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM shifts WHERE status = 'open' LIMIT 1")
    row = cursor.fetchone()
    conn.close()
    
    _cached_active_shift = dict(row) if row else None
    _cached_active_shift_ts = now
    return jsonify({"success": True, "shift": _cached_active_shift})

@app.route('/api/shift/open', methods=['POST'])
def open_shift():
    global _cached_active_shift, _cached_active_shift_ts
    data = request.json or {}
    cash_start = float(data.get('cash_start', 0.0) or 0.0)
    opened_by = session.get('cashier_name', 'Кассир')
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Check if there is already an open shift
    cursor.execute("SELECT id FROM shifts WHERE status = 'open' LIMIT 1")
    if cursor.fetchone():
        conn.close()
        return jsonify({"success": False, "message": "Смена уже открыта"}), 400
        
    now_str = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    cursor.execute('''
        INSERT INTO shifts (cash_start, opened_by, status, opened_at)
        VALUES (?, ?, 'open', ?)
    ''', (cash_start, opened_by, now_str))

    conn.commit()
    conn.close()
    
    _cached_active_shift = None
    _cached_active_shift_ts = 0
    return jsonify({"success": True, "message": "Смена успешно открыта"})

@app.route('/api/shift/services', methods=['POST'])
def add_shift_service():
    data = request.json or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({"success": False, "message": "Укажите название услуги"}), 400
        
    try:
        amount = float(data.get('amount', 0.0))
        if amount <= 0:
            return jsonify({"success": False, "message": "Сумма услуги должна быть больше 0"}), 400
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "Некорректная сумма услуги"}), 400
        
    payment_method = data.get('payment_method', 'cash').strip()
    if payment_method not in ['cash', 'card', 'transfer']:
        payment_method = 'cash'
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT id FROM shifts WHERE status = 'open' LIMIT 1")
    shift_row = cursor.fetchone()
    if not shift_row:
        conn.close()
        return jsonify({"success": False, "message": "Смена не открыта!"}), 400
    shift_id = shift_row['id']
    cashier_name = session.get('cashier_name', 'Кассир')
    
    cursor.execute('''
        INSERT INTO services (shift_id, name, amount, payment_method, cashier_name)
        VALUES (?, ?, ?, ?, ?)
    ''', (shift_id, name, amount, payment_method, cashier_name))
    
    service_id = cursor.lastrowid
    conn.commit()
    
    cursor.execute("SELECT * FROM services WHERE id = ?", (service_id,))
    service_item = dict(cursor.fetchone())
    conn.close()
    
    return jsonify({
        "success": True,
        "message": f"Услуга \"{name}\" на сумму {int(round(amount))} сум успешно добавлена!",
        "service": service_item
    })

@app.route('/api/shift/services/<int:service_id>', methods=['DELETE'])
def delete_shift_service(service_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM services WHERE id = ?", (service_id,))
    conn.commit()
    conn.close()
    return jsonify({"success": True, "message": "Услуга удалена"})

@app.route('/api/shift/expenses', methods=['POST'])
def add_shift_expense():
    data = request.json or {}
    category = (data.get('category') or '').strip()
    if not category:
        category = "Прочие расходы"
        
    description = (data.get('description') or '').strip()
    
    try:
        amount = float(data.get('amount', 0.0))
        if amount <= 0:
            return jsonify({"success": False, "message": "Сумма расхода должна быть больше 0"}), 400
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "Некорректная сумма расхода"}), 400
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT id FROM shifts WHERE status = 'open' LIMIT 1")
    shift_row = cursor.fetchone()
    if not shift_row:
        conn.close()
        return jsonify({"success": False, "message": "Смена не открыта!"}), 400
    shift_id = shift_row['id']
    cashier_name = session.get('cashier_name', 'Кассир')
    
    cursor.execute('''
        INSERT INTO expenses (amount, category, description, shift_id, cashier_name)
        VALUES (?, ?, ?, ?, ?)
    ''', (amount, category, description, shift_id, cashier_name))
    
    expense_id = cursor.lastrowid
    conn.commit()
    
    cursor.execute("SELECT * FROM expenses WHERE id = ?", (expense_id,))
    expense_item = dict(cursor.fetchone())
    conn.close()
    
    return jsonify({
        "success": True,
        "message": f"Расход \"{category}\" на сумму {int(round(amount))} сум списан из кассы!",
        "expense": expense_item
    })

@app.route('/api/shift/expenses/<int:expense_id>', methods=['DELETE'])
def delete_shift_expense(expense_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
    conn.commit()
    conn.close()
    return jsonify({"success": True, "message": "Расход удален"})

@app.route('/api/shift/preview', methods=['GET'])
def preview_shift():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM shifts WHERE status = 'open' LIMIT 1")
    shift_row = cursor.fetchone()
    if not shift_row:
        conn.close()
        return jsonify({"success": False, "message": "Нет активной смены"}), 400
        
    shift = dict(shift_row)
    shift_id = shift['id']
    
    # 1. Sales
    cash_actual, card_actual, transfer_actual = calculate_shift_sales(cursor, shift_id)

    # 2. Services
    cursor.execute('''
        SELECT payment_method, SUM(amount) as total
        FROM services
        WHERE shift_id = ?
        GROUP BY payment_method
    ''', (shift_id,))
    services_cash = 0.0
    services_card = 0.0
    services_transfer = 0.0
    for row in cursor.fetchall():
        method = row['payment_method']
        total = float(row['total'] or 0.0)
        if method == 'cash':
            services_cash = total
        elif method == 'card':
            services_card = total
        elif method == 'transfer':
            services_transfer = total

    # 3. Expenses
    cursor.execute('''
        SELECT SUM(amount) as total
        FROM expenses
        WHERE shift_id = ?
    ''', (shift_id,))
    exp_row = cursor.fetchone()
    expenses_total = float(exp_row[0] or 0.0) if exp_row else 0.0
    
    expected_cash = shift['cash_start'] + cash_actual + services_cash - expenses_total

    conn.close()
    return jsonify({
        "success": True,
        "shift_id": shift_id,
        "cash_start": shift['cash_start'],
        "cash_actual": cash_actual,
        "card_actual": card_actual,
        "transfer_actual": transfer_actual,
        "services_cash": services_cash,
        "services_card": services_card,
        "services_transfer": services_transfer,
        "expenses_total": expenses_total,
        "expected_cash": expected_cash
    })

@app.route('/api/shift/close', methods=['POST'])
def close_shift():
    data = request.json or {}
    cash_end = float(data.get('cash_end', 0.0) or 0.0)
    closed_by = session.get('cashier_name', 'Кассир')
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        cursor.execute("SELECT * FROM shifts WHERE status = 'open' LIMIT 1")
        shift_row = cursor.fetchone()
        if not shift_row:
            conn.close()
            return jsonify({"success": False, "message": "Нет активной открытой смены"}), 400
            
        shift = dict(shift_row)
        shift_id = shift['id']
        cash_start = float(shift.get('cash_start', 0.0) or 0.0)
        
        # Calculate actual sales by payment method
        cash_sales, card_sales, transfer_sales = calculate_shift_sales(cursor, shift_id)
        
        # Services breakdown
        cursor.execute('''
            SELECT payment_method, SUM(amount) as total
            FROM services
            WHERE shift_id = ?
            GROUP BY payment_method
        ''', (shift_id,))
        services_cash = 0.0
        services_card = 0.0
        services_transfer = 0.0
        for row in cursor.fetchall():
            method = row['payment_method']
            total = float(row['total'] or 0.0)
            if method == 'cash':
                services_cash = total
            elif method == 'card':
                services_card = total
            elif method == 'transfer':
                services_transfer = total
        
        # Expenses (cash out)
        cursor.execute("SELECT SUM(amount) FROM expenses WHERE shift_id = ?", (shift_id,))
        exp_row = cursor.fetchone()
        expenses_cash = float(exp_row[0] or 0.0) if exp_row else 0.0
        
        # Expected cash in drawer
        cash_expected = cash_start + cash_sales + services_cash - expenses_cash
        difference = cash_end - cash_expected
        
        cursor.execute('''
            UPDATE shifts 
            SET status = 'closed',
                closed_at = datetime('now', 'localtime'),
                cash_end = ?,
                cash_actual = ?,
                card_actual = ?,
                transfer_actual = ?,
                closed_by = ?
            WHERE id = ?
        ''', (cash_end, cash_sales, card_sales, transfer_sales, closed_by, shift_id))
        conn.commit()
        
        global _cached_active_shift, _cached_active_shift_ts
        _cached_active_shift = None
        _cached_active_shift_ts = 0
        
        # Check if Google Drive Sync is set to On Shift Close
        cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_sync_interval'")
        r = cursor.fetchone()
        interval = r[0] if r else "Off"
        conn.close()
        
        if interval == "On Shift Close":
            run_background_sync()
            
        report = {
            "shift_id": shift_id,
            "cash_start": cash_start,
            "cash_actual": cash_sales,
            "card_actual": card_sales,
            "transfer_actual": transfer_sales,
            "services_cash": services_cash,
            "services_card": services_card,
            "services_transfer": services_transfer,
            "expenses_total": expenses_cash,
            "expected_cash": cash_expected,
            "cash_end": cash_end,
            "discrepancy": difference
        }
            
        return jsonify({
            "success": True,
            "message": "Смена успешно закрыта!",
            "report": report,
            "shift_id": shift_id,
            "cash_expected": cash_expected,
            "cash_end": cash_end,
            "difference": difference
        })
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        conn.close()
        return jsonify({"success": False, "message": f"Ошибка закрытия смены: {str(e)}"}), 500

@app.route('/api/shift/sales', methods=['GET'])
def get_current_shift_sales():
    global _cached_active_shift, _cached_active_shift_ts
    if _cached_active_shift is None and (time.time() - _cached_active_shift_ts < 2.0):
        return jsonify({"success": True, "sales": [], "services": [], "expenses": [], "shift": None})

    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM shifts WHERE status = 'open' LIMIT 1")
    shift_row = cursor.fetchone()
    if not shift_row:
        _cached_active_shift = None
        _cached_active_shift_ts = time.time()
        conn.close()
        return jsonify({"success": True, "sales": [], "services": [], "expenses": [], "shift": None})
        
    shift = dict(shift_row)
    _cached_active_shift = shift
    _cached_active_shift_ts = time.time()
    shift_id = shift['id']
    
    cursor.execute('''
        SELECT s.id, s.product_id, COALESCE(p.name, '[Удаленный товар (ID ' || s.product_id || ')]') as product_name,
               COALESCE(p.barcode, '—') as barcode, s.quantity, s.price_original, s.discount_percent,
               s.price_final, s.payment_method, s.mix_cash, s.mix_card, s.sold_at, s.cost_price
        FROM sales s
        LEFT JOIN products p ON s.product_id = p.id
        WHERE s.shift_id = ?
        ORDER BY s.id DESC
    ''', (shift_id,))
    sales_records = [dict(r) for r in cursor.fetchall()]
    
    cursor.execute("SELECT * FROM services WHERE shift_id = ? ORDER BY id DESC", (shift_id,))
    services_records = [dict(r) for r in cursor.fetchall()]
    
    cursor.execute("SELECT * FROM expenses WHERE shift_id = ? ORDER BY id DESC", (shift_id,))
    expenses_records = [dict(r) for r in cursor.fetchall()]
    
    conn.close()
    return jsonify({
        "success": True,
        "shift": shift,
        "sales": sales_records,
        "services": services_records,
        "expenses": expenses_records
    })

@app.route('/api/shifts', methods=['GET'])
def get_all_shifts():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        cursor.execute("SELECT * FROM shifts ORDER BY id DESC")
        shift_rows = cursor.fetchall()
        
        # Batch query 1: All services totals grouped by shift_id in 1 query
        cursor.execute("""
            SELECT 
                shift_id,
                COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN amount ELSE 0 END), 0) as srv_cash,
                COALESCE(SUM(CASE WHEN payment_method = 'card' THEN amount ELSE 0 END), 0) as srv_card,
                COALESCE(SUM(CASE WHEN payment_method = 'transfer' THEN amount ELSE 0 END), 0) as srv_transfer
            FROM services
            GROUP BY shift_id
        """)
        srv_map = {}
        for r in cursor.fetchall():
            s_dict = dict(r)
            srv_map[s_dict['shift_id']] = {
                'cash': float(s_dict.get('srv_cash') or 0.0),
                'card': float(s_dict.get('srv_card') or 0.0),
                'transfer': float(s_dict.get('srv_transfer') or 0.0)
            }
            
        # Batch query 2: All expenses totals grouped by shift_id in 1 query
        cursor.execute("SELECT shift_id, COALESCE(SUM(amount), 0) as total FROM expenses GROUP BY shift_id")
        exp_map = {r['shift_id']: float(r['total'] or 0.0) for r in cursor.fetchall()}
        
        shifts = []
        for s in shift_rows:
            shift_dict = dict(s)
            s_id = shift_dict['id']
            
            # If shift is open, calculate live sales (only 1 open shift can exist at most)
            if shift_dict.get('status') == 'open':
                cash_actual, card_actual, transfer_actual = calculate_shift_sales(cursor, s_id)
                shift_dict['cash_actual'] = cash_actual
                shift_dict['card_actual'] = card_actual
                shift_dict['transfer_actual'] = transfer_actual
            else:
                shift_dict['cash_actual'] = float(shift_dict.get('cash_actual') or 0.0)
                shift_dict['card_actual'] = float(shift_dict.get('card_actual') or 0.0)
                shift_dict['transfer_actual'] = float(shift_dict.get('transfer_actual') or 0.0)
                
            srv = srv_map.get(s_id, {'cash': 0.0, 'card': 0.0, 'transfer': 0.0})
            shift_dict['services_cash'] = srv['cash']
            shift_dict['services_card'] = srv['card']
            shift_dict['services_transfer'] = srv['transfer']
            
            shift_dict['expenses_total'] = exp_map.get(s_id, 0.0)
            shift_dict['cash_start'] = float(shift_dict.get('cash_start') or 0.0)
            shift_dict['cash_end'] = float(shift_dict.get('cash_end') or 0.0) if shift_dict.get('cash_end') is not None else None
            
            shifts.append(shift_dict)
            
        conn.close()
        return jsonify({"success": True, "shifts": shifts})
    except Exception as e:
        if conn:
            conn.close()
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/shifts/<int:shift_id>/sales', methods=['GET'])
def get_shift_sales_history(shift_id):
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM shifts WHERE id = ?", (shift_id,))
    shift_row = cursor.fetchone()
    if not shift_row:
        conn.close()
        return jsonify({"success": False, "message": "Смена не найдена"}), 404
        
    shift = dict(shift_row)
    
    cursor.execute('''
        SELECT s.id, s.product_id, COALESCE(p.name, '[Удаленный товар (ID ' || s.product_id || ')]') as product_name,
               COALESCE(p.barcode, '—') as barcode, s.quantity, s.price_original, s.discount_percent,
               s.price_final, s.payment_method, s.mix_cash, s.mix_card, s.sold_at, s.cost_price
        FROM sales s
        LEFT JOIN products p ON s.product_id = p.id
        WHERE s.shift_id = ?
        ORDER BY s.id DESC
    ''', (shift_id,))
    sales_records = [dict(r) for r in cursor.fetchall()]
    
    cursor.execute("SELECT * FROM services WHERE shift_id = ? ORDER BY id DESC", (shift_id,))
    services_records = [dict(r) for r in cursor.fetchall()]
    
    cursor.execute("SELECT * FROM expenses WHERE shift_id = ? ORDER BY id DESC", (shift_id,))
    expenses_records = [dict(r) for r in cursor.fetchall()]
    
    total_qty = 0
    sales_total = 0.0
    cash_sales = 0.0
    card_sales = 0.0
    transfer_sales = 0.0
    
    for s in sales_records:
        qty = s.get('quantity', 1)
        subtotal = float(s.get('price_final', 0.0)) * qty
        total_qty += qty
        sales_total += subtotal
        pm = s.get('payment_method', 'cash')
        if pm == 'cash':
            cash_sales += subtotal
        elif pm == 'card':
            card_sales += subtotal
        elif pm == 'transfer':
            transfer_sales += subtotal
        elif pm == 'mix':
            cash_sales += float(s.get('mix_cash') or 0.0)
            card_sales += float(s.get('mix_card') or 0.0)
            
    services_cash = sum(float(srv.get('amount', 0.0)) for srv in services_records if srv.get('payment_method') == 'cash')
    services_card = sum(float(srv.get('amount', 0.0)) for srv in services_records if srv.get('payment_method') == 'card')
    services_transfer = sum(float(srv.get('amount', 0.0)) for srv in services_records if srv.get('payment_method') == 'transfer')
    services_total = services_cash + services_card + services_transfer
    
    expenses_total = sum(float(exp.get('amount', 0.0)) for exp in expenses_records)
    
    conn.close()
    
    return jsonify({
        "success": True,
        "shift": shift,
        "sales": sales_records,
        "services": services_records,
        "expenses": expenses_records,
        "totals": {
            "total_items": total_qty,
            "sales_total": sales_total,
            "cash_sales": cash_sales,
            "card_sales": card_sales,
            "transfer_sales": transfer_sales,
            "services_total": services_total,
            "services_cash": services_cash,
            "services_card": services_card,
            "services_transfer": services_transfer,
            "expenses_total": expenses_total,
            "revenue_total": sales_total + services_total
        }
    })

# --- SALES ENDPOINTS ---

@app.route('/api/sales', methods=['POST'])
def make_sale():
    # Accessible to Cashier
    data = request.json or {}
    payment_method = data.get('payment_method', 'cash').strip()
    if payment_method not in ['cash', 'card', 'transfer', 'mix']:
        payment_method = 'cash'
    mix_cash = float(data.get('mix_cash', 0.0) or 0.0)
    mix_card = float(data.get('mix_card', 0.0) or 0.0)
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Check if there is an active open shift
    cursor.execute("SELECT id FROM shifts WHERE status = 'open'")
    shift_row = cursor.fetchone()
    if not shift_row:
        conn.close()
        return jsonify({"success": False, "message": "Смена не открыта! Пожалуйста, откройте смену в кассе для проведения продаж."}), 400
    shift_id = shift_row['id']
    
    # Check if this is a batch request or a single item fallback
    if 'items' in data:
        items = data['items']
    else:
        # Wrap single sale request for backward compatibility
        barcode = data.get('barcode', '').strip()
        discount_percent = data.get('discount_percent', 0)
        quantity = data.get('quantity', 1)
        items = [{
            "barcode": barcode,
            "quantity": quantity,
            "discount_percent": discount_percent
        }]
        
    try:
        sales_records = []
        with conn:
            # 1. Pre-resolve products and calculate total order sum
            resolved_items = []
            total_order_sum = 0
            for item in items:
                item_barcode = item.get('barcode', '').strip()
                try:
                    item_qty = int(item.get('quantity', 1))
                    if item_qty <= 0:
                        raise ValueError("Количество должно быть больше 0")
                except (TypeError, ValueError):
                    raise ValueError("Некорректное количество товара")
                    
                try:
                    item_discount = float(item.get('discount_percent', 0.0))
                except (TypeError, ValueError):
                    raise ValueError("Некорректная скидка")
                    
                if not (0.0 <= item_discount <= 100.0):
                    raise ValueError("Скидка должна быть от 0% до 100%")
                    
                # Fast in-memory resolution of product (<0.1ms)
                product_row = find_product_by_barcode(item_barcode)
                if not product_row and item.get('product_id'):
                    _, _, id_map = get_or_load_catalog()
                    product_row = id_map.get(int(item.get('product_id')))
                    
                if not product_row:
                    raise ValueError(f"Товар со штрихкодом '{item_barcode}' не найден")
                    
                product = dict(product_row)
                if product['stock'] < item_qty:
                    raise ValueError(f"Недостаточно товара '{product['name']}' на складе. В наличии: {product['stock']}")
                    
                price_original = product['price']
                price_final = int(round(price_original * (1 - item_discount / 100)))
                subtotal = price_final * item_qty
                total_order_sum += subtotal
                
                resolved_items.append({
                    "product": product,
                    "item_qty": item_qty,
                    "item_discount": item_discount,
                    "price_original": price_original,
                    "price_final": price_final,
                    "subtotal": subtotal
                })

            # 2. Distribute mix_cash and mix_card and insert records
            accumulated_mix_cash = 0.0
            accumulated_mix_card = 0.0

            for idx, r_item in enumerate(resolved_items):
                product = r_item['product']
                item_qty = r_item['item_qty']
                item_discount = r_item['item_discount']
                price_original = r_item['price_original']
                price_final = r_item['price_final']
                subtotal = r_item['subtotal']
                
                # Subtract stock
                cursor.execute("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?", (item_qty, product['id'], item_qty))
                if cursor.rowcount == 0:
                    raise ValueError(f"Недостаточно товара '{product['name']}' на складе.")
                    
                if payment_method == 'mix' and total_order_sum > 0:
                    if idx == len(resolved_items) - 1:
                        item_mix_cash = round(mix_cash - accumulated_mix_cash, 2)
                        item_mix_card = round(mix_card - accumulated_mix_card, 2)
                    else:
                        ratio = subtotal / total_order_sum
                        item_mix_cash = round(mix_cash * ratio, 2)
                        item_mix_card = round(mix_card * ratio, 2)
                        accumulated_mix_cash += item_mix_cash
                        accumulated_mix_card += item_mix_card
                else:
                    item_mix_cash = 0.0
                    item_mix_card = 0.0

                # Insert sale record
                cursor.execute('''
                    INSERT INTO sales (product_id, quantity, price_original, discount_percent, price_final, cost_price, shift_id, payment_method, mix_cash, mix_card, sold_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'))
                ''', (product['id'], item_qty, price_original, item_discount, price_final, product.get('cost_price', 0.0), shift_id, payment_method, item_mix_cash, item_mix_card))
                
                sales_records.append({
                    "product_name": product['name'],
                    "quantity": item_qty,
                    "price_original": price_original,
                    "discount_percent": item_discount,
                    "price_final": price_final,
                    "payment_method": payment_method,
                    "mix_cash": item_mix_cash,
                    "mix_card": item_mix_card
                })
                
        # Check if Google Drive Sync is set to On Sale
        cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_sync_interval'")
        r = cursor.fetchone()
        interval = r[0] if r else "Off"
        conn.close()
        invalidate_catalog_cache()
        
        if interval == "On Sale":
            run_background_sync()
            
        return jsonify({
            "success": True,
            "message": "Продажа успешно совершена",
            "sales": sales_records,
            # Fallback for single item consumers
            "sale": sales_records[0] if sales_records else None
        })
        
    except ValueError as e:
        conn.close()
        return jsonify({"success": False, "message": str(e)}), 400
    except Exception as e:
        conn.close()
        return jsonify({"success": False, "message": f"Ошибка транзакции: {str(e)}"}), 500

@app.route('/download/apk', methods=['GET'])
def download_owner_apk():
    apk_path = r"C:\Users\user\.gemini\antigravity\scratch\easy-crm-mobile\easy-crm-owner.apk"
    if os.path.exists(apk_path):
        return send_file(apk_path, as_attachment=True, download_name="easy-crm-owner.apk")
    return jsonify({"error": "APK not found"}), 404

# --- DASHBOARD & ANALYTICS ---

def compute_stats_internal(cursor):
    # === TODAY'S STATS ===
    cursor.execute("""
        SELECT 
            COALESCE(SUM(price_final * quantity), 0),
            COALESCE(SUM((price_final - cost_price) * quantity), 0),
            COALESCE(SUM(quantity), 0)
        FROM sales
        WHERE DATE(sold_at) = DATE('now', 'localtime')
    """)
    t_row = cursor.fetchone()
    today_revenue = float(t_row[0] or 0.0)
    today_profit = float(t_row[1] or 0.0)
    today_items_sold = int(t_row[2] or 0)
    
    cursor.execute("SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE DATE(expense_date) = DATE('now', 'localtime')")
    today_expenses = float(cursor.fetchone()[0] or 0.0)
    today_net_profit = today_profit - today_expenses
    
    cursor.execute('''
        SELECT COALESCE(p.name, '[Удаленный товар (ID ' || s.product_id || ')]') as name, SUM(s.quantity) as sold_qty, SUM(s.price_final * s.quantity) as revenue
        FROM sales s
        LEFT JOIN products p ON s.product_id = p.id
        WHERE DATE(s.sold_at) = DATE('now', 'localtime')
        GROUP BY s.product_id, p.name
        ORDER BY sold_qty DESC
        LIMIT 5
    ''')
    today_top_products = [dict(row) for row in cursor.fetchall()]
    
    cursor.execute('''
        SELECT s.id, s.product_id, COALESCE(p.name, '[Удаленный товар (ID ' || s.product_id || ')]') as product_name, 
               COALESCE(p.barcode, '—') as barcode, s.quantity, s.price_original, s.discount_percent, 
               s.price_final, s.sold_at, s.cost_price, s.payment_method, s.mix_cash, s.mix_card
        FROM sales s
        LEFT JOIN products p ON s.product_id = p.id
        WHERE DATE(s.sold_at) = DATE('now', 'localtime')
        ORDER BY s.id DESC
        LIMIT 50
    ''')
    today_sales_list = [dict(row) for row in cursor.fetchall()]
    
    cursor.execute('''
        SELECT COALESCE(NULLIF(p.type, ''), 'Без категории') as type_name, SUM(s.quantity) as sold_qty, SUM(s.price_final * s.quantity) as revenue
        FROM sales s
        LEFT JOIN products p ON s.product_id = p.id
        WHERE DATE(s.sold_at) = DATE('now', 'localtime')
        GROUP BY p.type
        ORDER BY revenue DESC, sold_qty DESC
    ''')
    today_sales_by_type = [dict(row) for row in cursor.fetchall()]
    
    # === ALL-TIME STATS ===
    cursor.execute("""
        SELECT 
            COALESCE(SUM(price_final * quantity), 0),
            COALESCE(SUM((price_final - cost_price) * quantity), 0),
            COALESCE(SUM(quantity), 0)
        FROM sales
    """)
    at_row = cursor.fetchone()
    total_revenue = float(at_row[0] or 0.0)
    total_profit = float(at_row[1] or 0.0)
    total_items_sold = int(at_row[2] or 0)
    
    cursor.execute("SELECT COALESCE(SUM(amount), 0) FROM expenses")
    total_expenses = float(cursor.fetchone()[0] or 0.0)
    total_net_profit = total_profit - total_expenses
    
    cursor.execute('''
        SELECT s.id, s.product_id, COALESCE(p.name, '[Удаленный товар (ID ' || s.product_id || ')]') as product_name, 
               COALESCE(p.barcode, '—') as barcode, s.quantity, s.price_original, s.discount_percent, 
               s.price_final, s.sold_at, s.cost_price, s.payment_method, s.mix_cash, s.mix_card
        FROM sales s
        LEFT JOIN products p ON s.product_id = p.id
        ORDER BY s.id DESC
        LIMIT 50
    ''')
    all_time_sales_list = [dict(row) for row in cursor.fetchall()]
    
    cursor.execute('''
        SELECT COALESCE(p.name, '[Удаленный товар (ID ' || s.product_id || ')]') as name, SUM(s.quantity) as sold_qty, SUM(s.price_final * s.quantity) as revenue
        FROM sales s
        LEFT JOIN products p ON s.product_id = p.id
        GROUP BY s.product_id, p.name
        ORDER BY sold_qty DESC
        LIMIT 5
    ''')
    all_time_top_products = [dict(row) for row in cursor.fetchall()]

    cursor.execute('''
        SELECT COALESCE(NULLIF(p.type, ''), 'Без категории') as type_name, SUM(s.quantity) as sold_qty, SUM(s.price_final * s.quantity) as revenue
        FROM sales s
        LEFT JOIN products p ON s.product_id = p.id
        GROUP BY p.type
        ORDER BY revenue DESC, sold_qty DESC
    ''')
    all_time_sales_by_type = [dict(row) for row in cursor.fetchall()]
    
    # === GLOBAL METRICS ===
    cursor.execute("""
        SELECT 
            COUNT(*),
            COALESCE(SUM(CASE WHEN stock = 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(COALESCE(cost_price, 0.0) * stock), 0),
            COALESCE(SUM(COALESCE(price, 0.0) * stock), 0)
        FROM products WHERE is_deleted = 0
    """)
    gm_row = cursor.fetchone()
    total_products = int(gm_row[0] or 0)
    out_of_stock_count = int(gm_row[1] or 0)
    inventory_value_cost = round(float(gm_row[2] or 0.0))
    inventory_value_sell = round(float(gm_row[3] or 0.0))
    expected_profit = inventory_value_sell - inventory_value_cost

    cursor.execute('''
        SELECT DATE(sold_at) as date, 
               SUM(price_final * quantity) as revenue, 
               SUM((price_final - cost_price) * quantity) as profit,
               SUM(quantity) as items_count
        FROM sales
        GROUP BY DATE(sold_at)
        ORDER BY date DESC
        LIMIT 7
    ''')
    sales_by_day = [dict(row) for row in cursor.fetchall()]
    
    cursor.execute('''
        SELECT p.id, p.name, p.barcode, p.stock, s.last_sale
        FROM products p
        LEFT JOIN (
            SELECT product_id, MAX(sold_at) as last_sale
            FROM sales
            GROUP BY product_id
        ) s ON p.id = s.product_id
        WHERE p.is_deleted = 0
        ORDER BY s.last_sale ASC NULLS FIRST, p.id ASC
        LIMIT 50
    ''')
    stagnant_rows = cursor.fetchall()
    stagnant_products = []
    for row in stagnant_rows:
        stagnant_products.append({
            "id": row['id'],
            "name": row['name'],
            "barcode": row['barcode'],
            "stock": row['stock'],
            "last_sale": row['last_sale']
        })
        
        
    cursor.execute('''
        SELECT 
            COALESCE(NULLIF(TRIM(COALESCE(p.brand, '') || ' ' || COALESCE(p.model, '')), ''), 'Без модели') as phone_model,
            SUM(s.quantity) as sold_qty,
            SUM(s.price_final * s.quantity) as revenue
        FROM sales s
        LEFT JOIN products p ON s.product_id = p.id
        WHERE DATE(s.sold_at) = DATE('now', 'localtime')
        GROUP BY 1
        ORDER BY revenue DESC, sold_qty DESC
        LIMIT 20
    ''')
    today_sales_by_model = [dict(row) for row in cursor.fetchall()]

    cursor.execute('''
        SELECT 
            COALESCE(p.name, '[Удаленный товар (ID ' || s.product_id || ')]') as name,
            COALESCE(p.barcode, '—') as barcode,
            SUM(s.quantity) as sold_qty,
            SUM(s.price_final * s.quantity) as revenue,
            SUM((s.price_final - s.cost_price) * s.quantity) as profit
        FROM sales s
        LEFT JOIN products p ON s.product_id = p.id
        WHERE DATE(s.sold_at) = DATE('now', 'localtime')
        GROUP BY s.product_id, p.name, p.barcode
        ORDER BY revenue DESC, sold_qty DESC
        LIMIT 20
    ''')
    today_top_products_detailed = [dict(row) for row in cursor.fetchall()]

        
    cursor.execute('''
        SELECT 
            COALESCE(NULLIF(TRIM(COALESCE(p.brand, '') || ' ' || COALESCE(p.model, '')), ''), 'Без модели') as phone_model,
            SUM(s.quantity) as sold_qty,
            SUM(s.price_final * s.quantity) as revenue
        FROM sales s
        LEFT JOIN products p ON s.product_id = p.id
        GROUP BY 1
        ORDER BY revenue DESC, sold_qty DESC
        LIMIT 20
    ''')
    all_time_sales_by_model = [dict(row) for row in cursor.fetchall()]

    cursor.execute('''
        SELECT 
            COALESCE(p.name, '[Удаленный товар (ID ' || s.product_id || ')]') as name,
            COALESCE(p.barcode, '—') as barcode,
            SUM(s.quantity) as sold_qty,
            SUM(s.price_final * s.quantity) as revenue,
            SUM((s.price_final - s.cost_price) * s.quantity) as profit
        FROM sales s
        LEFT JOIN products p ON s.product_id = p.id
        GROUP BY s.product_id, p.name, p.barcode
        ORDER BY revenue DESC, sold_qty DESC
        LIMIT 20
    ''')
    all_time_top_products_detailed = [dict(row) for row in cursor.fetchall()]
    return {
    "today": {
            "revenue": round(today_revenue, 2),
            "profit": round(today_profit, 2),
            "expenses": round(today_expenses, 2),
            "net_profit": round(today_net_profit, 2),
            "items_sold": today_items_sold,
            "top_products": today_top_products,
            "sales_list": today_sales_list,
            "sales_by_type": today_sales_by_type,
            "sales_by_model": today_sales_by_model,
            "top_products_detailed": today_top_products_detailed
        },

        "all_time": {
            "revenue": round(total_revenue, 2),
            "profit": round(total_profit, 2),
            "expenses": round(total_expenses, 2),
            "net_profit": round(total_net_profit, 2),
            "items_sold": total_items_sold,
            "top_products": all_time_top_products,
            "sales_list": all_time_sales_list,
            "sales_by_type": all_time_sales_by_type,
            "sales_by_model": all_time_sales_by_model,
            "top_products_detailed": all_time_top_products_detailed
        },
        "inventory_value": {
            "cost": round(inventory_value_cost, 2),
            "selling": round(inventory_value_sell, 2),
            "expected_profit": round(expected_profit, 2)
        },
        "out_of_stock_count": out_of_stock_count,
        "total_products": total_products,
        "sales_by_day": sales_by_day[::-1],
        "stagnant_products": stagnant_products
    }

@app.route('/api/ai/analyze', methods=['GET'])
def ai_analyze():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # Get basic stock valuation
        cursor.execute("SELECT SUM(IFNULL(cost_price, 0.0) * stock), SUM(IFNULL(price, 0.0) * stock) FROM products WHERE is_deleted = 0")
        val_row = cursor.fetchone()
        val_cost = val_row[0] or 0.0
        val_retail = val_row[1] or 0.0
        expected_profit = val_retail - val_cost
        
        # Calculate markup percentage
        avg_markup = 0.0
        if val_cost > 0:
            avg_markup = (expected_profit / val_cost) * 100.0
            
        # Get count of distinct items and total units
        cursor.execute("SELECT COUNT(*), SUM(stock) FROM products WHERE is_deleted = 0")
        stock_summary = cursor.fetchone()
        total_types = stock_summary[0] or 0
        total_qty = stock_summary[1] or 0
        
        # Calculate critical shortage (stock <= 2 and has sales history)
        cursor.execute('''
            SELECT p.name, p.stock, (SELECT SUM(s.quantity) FROM sales s WHERE s.product_id = p.id) as sold_count
            FROM products p
            WHERE p.stock <= 2 AND p.stock > 0 AND sold_count > 0
            ORDER BY sold_count DESC
            LIMIT 10
        ''')
        shortage_rows = cursor.fetchall()
        procurement = []
        for row in shortage_rows:
            # recommend a target of 5 units
            recommend_qty = 5 - row['stock']
            procurement.append({
                "name": row['name'],
                "stock": row['stock'],
                "recommend": recommend_qty
            })
            
        # Calculate dead stock (stock > 0 and 0 sales in history)
        cursor.execute('''
            SELECT name, stock, cost_price
            FROM products
            WHERE stock > 0
              AND id NOT IN (SELECT DISTINCT product_id FROM sales)
            ORDER BY stock DESC
            LIMIT 10
        ''')
        dead_rows = cursor.fetchall()
        dead_stock = []
        dead_valuation = 0.0
        for row in dead_rows:
            cost = row['cost_price'] or 0.0
            dead_stock.append({
                "name": row['name'],
                "stock": row['stock'],
                "cost_price": cost
            })
            dead_valuation += cost * row['stock']
            
        # Find best performing category (type) based on sales
        cursor.execute('''
            SELECT p.type, SUM(s.quantity) as sold_qty, SUM(s.price_final * s.quantity) as revenue
            FROM sales s
            JOIN products p ON s.product_id = p.id
            GROUP BY p.type
            ORDER BY revenue DESC
            LIMIT 1
        ''')
        bestseller_row = cursor.fetchone()
        bestseller_type = bestseller_row['type'] if bestseller_row and bestseller_row['type'] else "Не определено"
        bestseller_revenue = bestseller_row['revenue'] if bestseller_row and bestseller_row['revenue'] else 0.0
        
        # Construct dynamic AI Insights text
        insights = (
            f"🧠 **ИИ-Консультант приветствует вас!** Представляю вам экспресс-аудит состояния склада:\n\n"
            f"1. 📊 **Финансовая эффективность**: Общий объем капитала, задействованного на складе, составляет **{int(round(val_cost))} сум** по себестоимости. При успешной розничной реализации всех остатков выручка составит **{int(round(val_retail))} сум**, что обеспечит чистую прибыль в размере **{int(round(expected_profit))} сум** со средней торговой наценкой **{avg_markup:.1f}%**.\n\n"
            f"2. ⚠️ **Критические риски (Дефицит)**: Найдено **{len(procurement)} ходовых товаров**, запас которых упал ниже критической отметки (2 шт.). Чтобы не терять клиентов, рекомендуется незамедлительно пополнить запасы в объеме, указанном в таблице слева.\n\n"
            f"3. 📉 **Скрытые потери (Неликвид)**: Выявлено неликвидных товаров на сумму **{int(round(dead_valuation))} сум** по себестоимости (эти позиции имеют нулевые продажи). Замороженный капитал снижает оборачиваемость бизнеса. Рекомендуется провести распродажу этих позиций со скидкой.\n\n"
            f"4. 💡 **Стратегическая рекомендация**: Вашим локомотивом продаж является категория **\"{bestseller_type}\"** с выручкой **{int(round(bestseller_revenue))} сум**. Расширение ассортимента и поддержка неснижаемых запасов в этой категории дадут наибольший прирост прибыли."
        )
        
        conn.close()
        return jsonify({
            "success": True,
            "val_cost": val_cost,
            "val_retail": val_retail,
            "shortage_count": len(procurement),
            "dead_valuation": dead_valuation,
            "procurement": procurement,
            "dead_stock": dead_stock,
            "insights": insights
        })
    except Exception as e:
        conn.close()
        return jsonify({"success": False, "message": str(e)}), 500

@app.route('/api/ai/query', methods=['POST'])
def ai_query():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    data = request.json or {}
    text = data.get('text', '').lower().strip()
    
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # Get basic metrics
        cursor.execute("SELECT COUNT(*), SUM(stock) FROM products WHERE is_deleted = 0")
        prod_row = cursor.fetchone()
        total_distinct = prod_row[0] or 0
        total_qty = prod_row[1] or 0
        
        cursor.execute("SELECT SUM(cost_price * stock), SUM(price * stock) FROM products WHERE is_deleted = 0")
        val_row = cursor.fetchone()
        cost_val = val_row[0] or 0.0
        sell_val = val_row[1] or 0.0
        
        # Process queries
        if any(k in text for k in ["закуп", "докупить", "надо купить", "дефицит", "заказать", "мало"]):
            cursor.execute("SELECT name, stock FROM products WHERE stock <= 2 AND stock > 0 AND is_deleted = 0 ORDER BY stock ASC LIMIT 10")
            rows = cursor.fetchall()
            if not rows:
                reply = "ИИ-Анализ: На складе нет товаров с критическим остатком (менее 2 шт.). Склад полностью укомплектован!"
            else:
                items_list = ", ".join([f"\"{r['name']}\" ({r['stock']} шт.)" for r in rows])
                reply = f"ИИ-Анализ: Рекомендую срочно закупить следующие товары с низким остатком: {items_list}."
                
        elif any(k in text for k in ["денег", "стоимость", "капитал", "оценка", "сумма", "товар", "остат"]):
            reply = f"ИИ-Анализ: На складе сейчас {total_distinct} наименований товаров общим количеством {total_qty} шт. В товар вложено {int(round(cost_val))} сум по себестоимости. Потенциальная выручка при продаже составит {int(round(sell_val))} сум, ожидаемая прибыль — {int(round(sell_val - cost_val))} сум."
            
        elif any(k in text for k in ["неликвид", "не продается", "лежат", "заморожен", "стагн"]):
            cursor.execute('''
                SELECT p.name, p.stock, p.cost_price 
                FROM products p 
                WHERE p.stock > 0 
                  AND p.id NOT IN (SELECT DISTINCT product_id FROM sales)
                LIMIT 5
            ''')
            rows = cursor.fetchall()
            if not rows:
                reply = "ИИ-Анализ: Отлично! У вас нет товаров без истории продаж. Весь ассортимент показывает активность."
            else:
                stagnant_cost = sum((r['cost_price'] or 0.0) * r['stock'] for r in rows)
                items_list = ", ".join([f"\"{r['name']}\" ({r['stock']} шт.)" for r in rows])
                reply = f"ИИ-Анализ: Обнаружены неликвидные товары без продаж. В топ-5 входят: {items_list}. В этих позициях заморожено около {int(round(stagnant_cost))} сум по себестоимости. Рекомендуется пересмотреть цены."
                
        elif any(k in text for k in ["популярн", "хит", "часто", "топ", "лучшие", "продава"]):
            cursor.execute('''
                SELECT p.name, SUM(s.quantity) as sold_qty 
                FROM sales s 
                JOIN products p ON s.product_id = p.id 
                GROUP BY p.id 
                ORDER BY sold_qty DESC 
                LIMIT 5
            ''')
            rows = cursor.fetchall()
            if not rows:
                reply = "ИИ-Анализ: В системе пока нет зарегистрированных продаж для выявления лидеров."
            else:
                items_list = ", ".join([f"\"{r['name']}\" ({r['sold_qty']} шт.)" for r in rows])
                reply = f"ИИ-Анализ: Лидеры продаж на данный момент: {items_list}."
                
        else:
            reply = (f"Приветствую! Я ваш интеллектуальный ИИ-Анализатор остатков. "
                     f"Сейчас на вашем складе {total_distinct} видов товаров общим числом {total_qty} шт. "
                     f"Задайте мне конкретный вопрос, например: 'Что докупить?', 'Сколько денег в товаре?' или 'Покажи неликвид'.")
                     
        conn.close()
        return jsonify({"success": True, "speech": reply})
    except Exception as e:
        if conn:
            conn.close()
        return jsonify({"success": False, "message": str(e)}), 500


@app.route('/api/analytics/cases-purchase-matrix', methods=['GET'])
@app.route('/api/analytics/purchase-matrix', methods=['GET'])
def get_purchase_matrix():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    days = request.args.get('days', default=30, type=int)
    category_filter = request.args.get('category', default='all', type=str).strip().lower()
    brand_filter = request.args.get('brand', default='all', type=str).strip().lower()
    model_filter = request.args.get('model', default='all', type=str).strip().lower()
    lead_time_days = request.args.get('lead_time_days', default=14, type=int)
    safety_ratio = request.args.get('safety_ratio', default=1.2, type=float)
    model_limit = request.args.get('limit', default=0, type=int) # 0 means all products
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        from datetime import datetime, timedelta
        now = datetime.now()
        
        where_sales = ["p.is_deleted = 0"]
        params_sales = []
        
        if days and days > 0:
            since_date = (now - timedelta(days=days)).strftime('%Y-%m-%d 00:00:00')
            where_sales.append("s.sold_at >= ?")
            params_sales.append(since_date)
            
        if category_filter and category_filter != 'all':
            where_sales.append("LOWER(TRIM(p.type)) = ?")
            params_sales.append(category_filter)
            
        if brand_filter and brand_filter != 'all':
            where_sales.append("LOWER(TRIM(p.brand)) = ?")
            params_sales.append(brand_filter)
            
        if model_filter and model_filter != 'all':
            where_sales.append("LOWER(TRIM(p.model)) = ?")
            params_sales.append(model_filter)
            
        sql_sales = f"""
            SELECT 
                COALESCE(NULLIF(TRIM(p.type), ''), 'Разное') as category,
                COALESCE(NULLIF(TRIM(p.brand), ''), 'other') as brand,
                COALESCE(NULLIF(TRIM(p.model), ''), NULLIF(TRIM(p.name), ''), 'Без названия') as model,
                COALESCE(NULLIF(TRIM(p.unique_suffix), ''), NULLIF(TRIM(p.type), ''), 'Основной') as variation,
                SUM(s.quantity) as sold_qty,
                SUM(s.price_final * s.quantity) as total_revenue
            FROM sales s
            JOIN products p ON s.product_id = p.id
            WHERE {' AND '.join(where_sales)}
            GROUP BY 1, 2, 3, 4
            ORDER BY sold_qty DESC
        """
        cursor.execute(sql_sales, params_sales)
        sales_rows = [dict(r) for r in cursor.fetchall()]
        
        where_stock = ["p.is_deleted = 0"]
        params_stock = []
        if category_filter and category_filter != 'all':
            where_stock.append("LOWER(TRIM(p.type)) = ?")
            params_stock.append(category_filter)
        if brand_filter and brand_filter != 'all':
            where_stock.append("LOWER(TRIM(p.brand)) = ?")
            params_stock.append(brand_filter)
        if model_filter and model_filter != 'all':
            where_stock.append("LOWER(TRIM(p.model)) = ?")
            params_stock.append(model_filter)
            
        sql_stock = f"""
            SELECT 
                COALESCE(NULLIF(TRIM(p.type), ''), 'Разное') as category,
                COALESCE(NULLIF(TRIM(p.brand), ''), 'other') as brand,
                COALESCE(NULLIF(TRIM(p.model), ''), NULLIF(TRIM(p.name), ''), 'Без названия') as model,
                COALESCE(NULLIF(TRIM(p.unique_suffix), ''), NULLIF(TRIM(p.type), ''), 'Основной') as variation,
                SUM(p.stock) as current_stock,
                AVG(p.cost_price) as avg_cost,
                AVG(p.price) as avg_price,
                MAX(p.created_at) as max_created_at,
                MAX(s_sub.last_sold_at) as last_sold_at,
                MAX(pu_agg.last_purchased_at) as last_purchased_at
            FROM products p
            LEFT JOIN (
                SELECT product_id, MAX(sold_at) as last_sold_at FROM sales GROUP BY product_id
            ) s_sub ON p.id = s_sub.product_id
            LEFT JOIN (
                SELECT product_id, MAX(purchase_date) as last_purchased_at FROM purchases GROUP BY product_id
            ) pu_agg ON p.id = pu_agg.product_id
            WHERE {' AND '.join(where_stock)}
            GROUP BY 1, 2, 3, 4
        """
        cursor.execute(sql_stock, params_stock)
        stock_rows = [dict(r) for r in cursor.fetchall()]
        
        # Distinct categories, brands and models
        cursor.execute("""
            SELECT DISTINCT LOWER(TRIM(type)) FROM products 
            WHERE is_deleted = 0 AND type IS NOT NULL AND TRIM(type) != ''
            ORDER BY 1
        """)
        all_categories = [r[0] for r in cursor.fetchall() if r[0]]
        
        cursor.execute("""
            SELECT DISTINCT LOWER(TRIM(brand)) FROM products 
            WHERE is_deleted = 0 AND brand IS NOT NULL AND TRIM(brand) != ''
            ORDER BY 1
        """)
        all_brands = [r[0] for r in cursor.fetchall() if r[0]]
        
        model_where = ["is_deleted = 0", "model IS NOT NULL", "TRIM(model) != ''"]
        model_params = []
        if category_filter and category_filter != 'all':
            model_where.append("LOWER(TRIM(COALESCE(type, ''))) = ?")
            model_params.append(category_filter)
        if brand_filter and brand_filter != 'all':
            model_where.append("LOWER(TRIM(COALESCE(brand, ''))) = ?")
            model_params.append(brand_filter)
        cursor.execute(f"SELECT DISTINCT LOWER(TRIM(model)) FROM products WHERE {' AND '.join(model_where)} ORDER BY 1", model_params)
        all_models = [r[0] for r in cursor.fetchall() if r[0]]
        
        model_totals = {}
        type_totals = {}
        
        for r in sales_rows:
            m = r['model']
            t = r['variation']
            b = r['brand']
            c = r['category']
            qty = int(r['sold_qty'] or 0)
            rev = float(r['total_revenue'] or 0.0)
            
            if m not in model_totals:
                model_totals[m] = {'category': c, 'brand': b, 'model': m, 'sold_qty': 0, 'revenue': 0.0, 'stock': 0, 'initial_qty': 0, 'types': {}, 'has_recent_activity': False}
            model_totals[m]['sold_qty'] += qty
            model_totals[m]['revenue'] += rev
            
            if t not in model_totals[m]['types']:
                model_totals[m]['types'][t] = {'sold': 0, 'stock': 0, 'avg_cost': 0.0, 'avg_price': 0.0, 'existed': True}
            model_totals[m]['types'][t]['sold'] += qty
            
            if t not in type_totals:
                type_totals[t] = {'sold_qty': 0, 'stock': 0}
            type_totals[t]['sold_qty'] += qty

        for r in stock_rows:
            m = r['model']
            t = r['variation']
            b = r['brand']
            c = r['category']
            stk = int(r['current_stock'] or 0)
            
            # Check 20-day obsolescence rule for zero-stock items
            last_sold_str = r.get('last_sold_at')
            last_purchased_str = r.get('last_purchased_at')
            created_str = r.get('max_created_at')
            
            last_sold_dt = None
            if last_sold_str:
                try:
                    last_sold_dt = datetime.strptime(last_sold_str.split('.')[0], '%Y-%m-%d %H:%M:%S')
                except Exception:
                    pass
            last_purchased_dt = None
            if last_purchased_str:
                try:
                    last_purchased_dt = datetime.strptime(last_purchased_str.split('.')[0], '%Y-%m-%d %H:%M:%S')
                except Exception:
                    pass
            created_dt = None
            if created_str:
                try:
                    created_dt = datetime.strptime(created_str.split('.')[0], '%Y-%m-%d %H:%M:%S')
                except Exception:
                    pass
                    
            is_active = True
            if stk == 0:
                if last_sold_dt:
                    if (now - last_sold_dt).days > 20:
                        if not last_purchased_dt or (now - last_purchased_dt).days > 20:
                            is_active = False
                else:
                    if last_purchased_dt and (now - last_purchased_dt).days > 20:
                        is_active = False
                    elif not last_purchased_dt and created_dt and (now - created_dt).days > 20:
                        is_active = False
                    elif not last_purchased_dt and not created_dt:
                        is_active = False
                        
            if m not in model_totals:
                model_totals[m] = {'category': c, 'brand': b, 'model': m, 'sold_qty': 0, 'revenue': 0.0, 'stock': 0, 'initial_qty': 0, 'types': {}, 'has_recent_activity': is_active}
            model_totals[m]['stock'] += stk
            if is_active:
                model_totals[m]['has_recent_activity'] = True
            
            if t not in model_totals[m]['types']:
                model_totals[m]['types'][t] = {'sold': 0, 'stock': 0, 'avg_cost': float(r['avg_cost'] or 0.0), 'avg_price': float(r['avg_price'] or 0.0), 'existed': True}
            model_totals[m]['types'][t]['stock'] += stk
            model_totals[m]['types'][t]['avg_cost'] = float(r['avg_cost'] or 0.0)
            model_totals[m]['types'][t]['avg_price'] = float(r['avg_price'] or 0.0)
            model_totals[m]['types'][t]['existed'] = True
            
            if t not in type_totals:
                type_totals[t] = {'sold_qty': 0, 'stock': 0}
            type_totals[t]['stock'] += stk

        # Filter out obsolete models with 0 stock and no sales in last 20 days
        active_models = {}
        for m, m_info in model_totals.items():
            if m_info['stock'] > 0 or m_info['has_recent_activity']:
                m_info['initial_qty'] = m_info['stock'] + m_info['sold_qty']
                active_models[m] = m_info

        sorted_models = sorted(active_models.values(), key=lambda x: (1 if x['sold_qty'] > 0 and x['stock'] == 0 else 0, x['sold_qty'], x['stock']), reverse=True)
        if model_limit and model_limit > 0:
            sorted_models = sorted_models[:model_limit]
            
        top_variations = sorted(type_totals.keys(), key=lambda x: (type_totals[x]['sold_qty'], type_totals[x]['stock']), reverse=True)
        matrix_columns = top_variations[:20] if len(top_variations) > 20 else top_variations

        period_days = max(days, 1) if days > 0 else 30
        daily_lead_factor = (lead_time_days / period_days) * safety_ratio

        total_rec_units = 0
        matrix_rows = []
        
        for m_info in sorted_models:
            m_name = m_info['model']
            m_brand = m_info['brand']
            m_cat = m_info['category']
            m_sold = m_info['sold_qty']
            m_stock = m_info['stock']
            m_init = m_info['initial_qty']
            
            target_demand = int(round(m_sold * daily_lead_factor))
            if m_sold > 0 and target_demand < m_sold:
                target_demand = m_sold
            if m_sold == 0 and m_stock == 0:
                target_demand = 2
                
            recommended_qty = max(0, target_demand - m_stock)
            total_rec_units += recommended_qty
            
            if m_sold >= 1 and m_stock == 0:
                status = 'urgent'
                status_text = '🔴 Срочно заказать'
            elif recommended_qty > 0:
                status = 'replenish'
                status_text = '🟡 Докупить'
            elif m_stock > 0 and m_sold > 0:
                status = 'ok'
                status_text = '🟢 В достатке'
            else:
                status = 'excess'
                status_text = '⚪ Избыток'
                
            cells = {}
            for col_t in matrix_columns:
                t_data = m_info['types'].get(col_t, None)
                if t_data is not None:
                    cells[col_t] = {
                        'sold': t_data['sold'],
                        'stock': t_data['stock'],
                        'existed': True
                    }
                else:
                    cells[col_t] = {
                        'sold': 0,
                        'stock': 0,
                        'existed': False # Non-existent combination for this model!
                    }
                
            matrix_rows.append({
                'category': m_cat,
                'brand': m_brand,
                'model': m_name,
                'initial_qty': m_init,
                'sold_qty': m_sold,
                'revenue': m_info['revenue'],
                'stock': m_stock,
                'recommended_qty': recommended_qty,
                'status': status,
                'status_text': status_text,
                'cells': cells
            })
            
        # 1. Nested Donut
        inner_donut = []
        outer_donut = []
        
        model_colors = [
            '#206bc4', '#4299e1', '#0ca678', '#2fb344', '#f59f00', 
            '#f76707', '#d63939', '#ae3ec9', '#7048e8', '#17a2b8',
            '#6610f2', '#e83e8c', '#fd7e14', '#20c997', '#6c757d'
        ]
        
        top_n_models = sorted_models[:12]
        for idx, m_info in enumerate(top_n_models):
            if m_info['sold_qty'] <= 0:
                continue
            base_color = model_colors[idx % len(model_colors)]
            inner_donut.append({
                'name': m_info['model'],
                'value': m_info['sold_qty'],
                'color': base_color
            })
            
            sub_types = sorted(m_info['types'].items(), key=lambda x: x[1]['sold'], reverse=True)
            for sub_idx, (t_name, t_val) in enumerate(sub_types):
                if t_val['sold'] > 0:
                    outer_donut.append({
                        'name': f"{m_info['model']} • {t_name}",
                        'model': m_info['model'],
                        'case_type': t_name,
                        'value': t_val['sold']
                    })

        # 2. Stacked / Grouped Bar Data
        bar_categories = [m['model'] for m in sorted_models[:15] if m['sold_qty'] > 0]
        bar_series = []
        
        for t_name in matrix_columns[:10]:
            series_data = []
            has_any = False
            for m_name in bar_categories:
                val = model_totals.get(m_name, {}).get('types', {}).get(t_name, {}).get('sold', 0)
                series_data.append(val)
                if val > 0:
                    has_any = True
            if has_any:
                bar_series.append({
                    'name': t_name,
                    'data': series_data
                })
                
        total_items_sold = sum(r['sold_qty'] for r in sales_rows)
        total_items_rev = sum(r['total_revenue'] for r in sales_rows)
        top_model_name = sorted_models[0]['model'] if sorted_models else 'Нет данных'
        top_model_qty = sorted_models[0]['sold_qty'] if sorted_models else 0
        top_type_name = top_variations[0] if top_variations else 'Нет данных'
        top_type_qty = type_totals[top_type_name]['sold_qty'] if top_variations else 0

        conn.close()
        return jsonify({
            'success': True,
            'kpi': {
                'total_sold': total_items_sold,
                'total_revenue': total_items_rev,
                'top_model': {'name': top_model_name, 'qty': top_model_qty},
                'top_type': {'name': top_type_name, 'qty': top_type_qty},
                'total_recommended': total_rec_units,
                'models_count': len(sorted_models)
            },
            'categories': ['all'] + all_categories,
            'brands': ['all'] + all_brands,
            'models': ['all'] + all_models,
            'matrix': {
                'columns': matrix_columns,
                'rows': matrix_rows
            },
            'charts': {
                'nested_donut': {
                    'inner': inner_donut,
                    'outer': outer_donut
                },
                'stacked_bar': {
                    'categories': bar_categories,
                    'series': bar_series
                }
            }
        })
    except Exception as e:
        if conn:
            conn.close()
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500


@app.route('/api/analytics/procurement-list', methods=['GET'])
def get_procurement_list():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    days = request.args.get('days', default=30, type=int)
    category_filter = request.args.get('category', default='all', type=str).strip().lower()
    brand_filter = request.args.get('brand', default='all', type=str).strip().lower()
    model_filter = request.args.get('model', default='all', type=str).strip().lower()
    suffix_filter = request.args.get('suffix', default='all', type=str).strip().lower()
    supplier_filter = request.args.get('supplier', default='all', type=str).strip().lower()
    urgency_filter = request.args.get('urgency', default='all', type=str).strip().lower()
    lead_time_days = request.args.get('lead_time_days', default=14, type=int)
    safety_ratio = request.args.get('safety_ratio', default=1.2, type=float)
    search_query = request.args.get('search', default='', type=str).strip().lower()
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        from datetime import datetime, timedelta
        import math
        now = datetime.now()
        
        # Calculate sales in the given period
        period_days = max(days, 1) if days > 0 else 30
        
        sales_subquery = """
            SELECT product_id, SUM(quantity) as sold_qty, SUM(price_final * quantity) as revenue
            FROM sales
        """
        sales_params = []
        if days and days > 0:
            since_date = (now - timedelta(days=days)).strftime('%Y-%m-%d 00:00:00')
            sales_subquery += " WHERE sold_at >= ?"
            sales_params.append(since_date)
        sales_subquery += " GROUP BY product_id"
        
        where_clauses = ["p.is_deleted = 0"]
        params = []
        
        if category_filter and category_filter != 'all':
            where_clauses.append("LOWER(TRIM(COALESCE(p.type, ''))) = ?")
            params.append(category_filter)
            
        if brand_filter and brand_filter != 'all':
            where_clauses.append("LOWER(TRIM(COALESCE(p.brand, ''))) = ?")
            params.append(brand_filter)
            
        if model_filter and model_filter != 'all':
            where_clauses.append("LOWER(TRIM(COALESCE(p.model, ''))) = ?")
            params.append(model_filter)

        if suffix_filter and suffix_filter != 'all':
            where_clauses.append("LOWER(TRIM(COALESCE(p.unique_suffix, ''))) = ?")
            params.append(suffix_filter)
            
        if supplier_filter and supplier_filter != 'all':
            where_clauses.append("LOWER(TRIM(COALESCE(p.supplier, ''))) = ?")
            params.append(supplier_filter)
            
        if search_query:
            where_clauses.append("(LOWER(p.name) LIKE ? OR LOWER(COALESCE(p.barcode, '')) LIKE ? OR LOWER(COALESCE(p.model, '')) LIKE ? OR LOWER(COALESCE(p.unique_suffix, '')) LIKE ?)")
            search_param = f"%{search_query}%"
            params.extend([search_param, search_param, search_param, search_param])
            
        sql = f"""
            SELECT 
                p.id, p.name, p.barcode, p.type, p.brand, p.model, p.unique_suffix,
                p.cost_price, p.price, p.stock, p.supplier, p.created_at,
                COALESCE(s.sold_qty, 0) as sold_qty,
                COALESCE(s.revenue, 0.0) as revenue,
                s_last.last_sold_at,
                pu_last.last_purchased_at
            FROM products p
            LEFT JOIN ({sales_subquery}) s ON p.id = s.product_id
            LEFT JOIN (
                SELECT product_id, MAX(sold_at) as last_sold_at FROM sales GROUP BY product_id
            ) s_last ON p.id = s_last.product_id
            LEFT JOIN (
                SELECT product_id, MAX(purchase_date) as last_purchased_at FROM purchases GROUP BY product_id
            ) pu_last ON p.id = pu_last.product_id
            WHERE {' AND '.join(where_clauses)}
            ORDER BY (CASE WHEN p.stock = 0 THEN 0 WHEN p.stock <= 2 THEN 1 WHEN p.stock <= 5 THEN 2 ELSE 3 END) ASC,
                     (CASE WHEN p.stock = 0 THEN 0 ELSE p.stock END) ASC,
                     COALESCE(NULLIF(TRIM(p.unique_suffix), ''), 'zzz') ASC,
                     COALESCE(s.sold_qty, 0) DESC,
                     p.name ASC
        """
        
        cursor.execute(sql, sales_params + params)
        raw_rows = cursor.fetchall()
        
        # Get all distinct suppliers, categories, brands, models, and unique suffixes for filters
        cursor.execute("SELECT DISTINCT LOWER(TRIM(supplier)) FROM products WHERE is_deleted = 0 AND supplier IS NOT NULL AND TRIM(supplier) != '' ORDER BY 1")
        all_suppliers = [r[0] for r in cursor.fetchall() if r[0]]
        
        cursor.execute("SELECT DISTINCT LOWER(TRIM(type)) FROM products WHERE is_deleted = 0 AND type IS NOT NULL AND TRIM(type) != '' ORDER BY 1")
        all_categories = [r[0] for r in cursor.fetchall() if r[0]]
        
        cursor.execute("SELECT DISTINCT LOWER(TRIM(brand)) FROM products WHERE is_deleted = 0 AND brand IS NOT NULL AND TRIM(brand) != '' ORDER BY 1")
        all_brands = [r[0] for r in cursor.fetchall() if r[0]]
        
        model_where = ["is_deleted = 0", "model IS NOT NULL", "TRIM(model) != ''"]
        model_params = []
        if category_filter and category_filter != 'all':
            model_where.append("LOWER(TRIM(COALESCE(type, ''))) = ?")
            model_params.append(category_filter)
        if brand_filter and brand_filter != 'all':
            model_where.append("LOWER(TRIM(COALESCE(brand, ''))) = ?")
            model_params.append(brand_filter)
        cursor.execute(f"SELECT DISTINCT LOWER(TRIM(model)) FROM products WHERE {' AND '.join(model_where)} ORDER BY 1", model_params)
        all_models = [r[0] for r in cursor.fetchall() if r[0]]

        # Context-aware distinct unique suffixes (unique names)
        suffix_where = ["is_deleted = 0", "unique_suffix IS NOT NULL", "TRIM(unique_suffix) != ''"]
        suffix_params = []
        if category_filter and category_filter != 'all':
            suffix_where.append("LOWER(TRIM(COALESCE(type, ''))) = ?")
            suffix_params.append(category_filter)
        if brand_filter and brand_filter != 'all':
            suffix_where.append("LOWER(TRIM(COALESCE(brand, ''))) = ?")
            suffix_params.append(brand_filter)
        if model_filter and model_filter != 'all':
            suffix_where.append("LOWER(TRIM(COALESCE(model, ''))) = ?")
            suffix_params.append(model_filter)
        cursor.execute(f"SELECT DISTINCT LOWER(TRIM(unique_suffix)) FROM products WHERE {' AND '.join(suffix_where)} ORDER BY 1", suffix_params)
        all_suffixes = [r[0] for r in cursor.fetchall() if r[0]]
        
        # Calculate cumulative revenue for ABC analysis across active catalog
        cursor.execute(f"SELECT p.id, COALESCE(s.revenue, 0.0) as revenue FROM products p LEFT JOIN ({sales_subquery}) s ON p.id = s.product_id WHERE p.is_deleted = 0 ORDER BY COALESCE(s.revenue, 0.0) DESC", sales_params)
        all_rev_rows = cursor.fetchall()
        total_catalog_revenue = sum([float(r['revenue'] or 0.0) for r in all_rev_rows])
        
        abc_map = {}
        cum_rev = 0.0
        for r in all_rev_rows:
            p_id = r['id']
            rev = float(r['revenue'] or 0.0)
            if total_catalog_revenue > 0 and rev > 0:
                cum_rev += rev
                share = cum_rev / total_catalog_revenue
                if share <= 0.80:
                    abc_map[p_id] = 'A'
                elif share <= 0.95:
                    abc_map[p_id] = 'B'
                else:
                    abc_map[p_id] = 'C'
            else:
                abc_map[p_id] = 'C'
        
        daily_lead_factor = (lead_time_days / period_days) * safety_ratio
        
        items = []
        out_of_stock_count = 0
        critical_count = 0
        low_count = 0
        total_rec_units = 0
        total_rec_budget = 0.0
        total_rec_retail = 0.0
        
        for r in raw_rows:
            p_id = r['id']
            p_name = r['name'] or 'Без названия'
            p_barcode = r['barcode'] or ''
            p_type = r['type'] or ''
            p_brand = r['brand'] or ''
            p_model = r['model'] or ''
            p_suffix = r['unique_suffix'] or ''
            p_cost = float(r['cost_price'] or 0.0)
            p_price = float(r['price'] or 0.0)
            p_stock = int(r['stock'] or 0)
            p_supplier = r['supplier'] or 'Не указан'
            p_sold = int(r['sold_qty'] or 0)
            p_rev = float(r['revenue'] or 0.0)
            p_abc = abc_map.get(p_id, 'C')
            
            # --- 20-day Obsolescence Rule for Zero-Stock Items ---
            last_sold_str = r['last_sold_at']
            last_purchased_str = r['last_purchased_at']
            created_str = r['created_at']
            
            last_sold_dt = None
            if last_sold_str:
                try:
                    last_sold_dt = datetime.strptime(last_sold_str.split('.')[0], '%Y-%m-%d %H:%M:%S')
                except Exception:
                    pass
            last_purchased_dt = None
            if last_purchased_str:
                try:
                    last_purchased_dt = datetime.strptime(last_purchased_str.split('.')[0], '%Y-%m-%d %H:%M:%S')
                except Exception:
                    pass
            created_dt = None
            if created_str:
                try:
                    created_dt = datetime.strptime(created_str.split('.')[0], '%Y-%m-%d %H:%M:%S')
                except Exception:
                    pass
                    
            if p_stock == 0:
                is_obsolete = False
                if last_sold_dt:
                    if (now - last_sold_dt).days > 20:
                        if not last_purchased_dt or (now - last_purchased_dt).days > 20:
                            is_obsolete = True
                else:
                    if last_purchased_dt and (now - last_purchased_dt).days > 20:
                        is_obsolete = True
                    elif not last_purchased_dt and created_dt and (now - created_dt).days > 20:
                        is_obsolete = True
                    elif not last_purchased_dt and not created_dt:
                        is_obsolete = True
                if is_obsolete:
                    continue # Exclude discontinued zero-stock item from procurement!
            
            # Daily sales velocity
            daily_sales = p_sold / period_days if period_days > 0 else 0.0
            
            # Days of inventory remaining
            if daily_sales > 0:
                days_left = round(p_stock / daily_sales, 1)
            else:
                days_left = 999 if p_stock > 0 else 0
                
            # Recommended reorder calculation
            target_stock = int(math.ceil(p_sold * daily_lead_factor))
            if p_sold > 0 and target_stock < p_sold:
                target_stock = p_sold
            if p_sold == 0 and p_stock == 0:
                target_stock = 2 # Minimum reorder for zero-stock active items
            elif target_stock == 0 and p_stock <= 2:
                target_stock = 3 # Minimum baseline
                
            recommended_qty = max(0, target_stock - p_stock)
            calc_formula = f"Расход: {daily_sales:.2f} шт/дн × Буфер {lead_time_days}д = Цель {target_stock} шт (Остаток {p_stock} шт)"
            
            # Urgency level
            if p_stock == 0:
                urgency = 'out_of_stock'
                urgency_text = '🔴 Закончился (0 шт)'
                out_of_stock_count += 1
            elif p_stock <= 2:
                urgency = 'critical'
                urgency_text = '🟡 Критический (1-2 шт)'
                critical_count += 1
            elif p_stock <= 5:
                urgency = 'low'
                urgency_text = '🟠 Заканчивается (3-5 шт)'
                low_count += 1
            else:
                urgency = 'normal'
                urgency_text = '🟢 В норме'
                
            # Margin & Estimated procurement cost
            effective_cost = p_cost if p_cost > 0 else (p_price * 0.4 if p_price > 0 else 0.0)
            margin_unit = max(0.0, p_price - effective_cost)
            margin_pct = round((margin_unit / p_price) * 100, 1) if p_price > 0 else 0.0
            est_cost = recommended_qty * effective_cost
            est_retail = recommended_qty * p_price
            
            # Apply urgency filter if specified
            if urgency_filter == 'out_of_stock' and urgency != 'out_of_stock':
                continue
            elif urgency_filter == 'critical' and urgency != 'critical':
                continue
            elif urgency_filter == 'low' and urgency != 'low':
                continue
            elif urgency_filter == 'all_procurement' and recommended_qty <= 0 and p_stock > 5:
                continue
                
            total_rec_units += recommended_qty
            total_rec_budget += est_cost
            total_rec_retail += est_retail
            
            items.append({
                'id': p_id,
                'name': p_name,
                'barcode': p_barcode,
                'type': p_type,
                'brand': p_brand,
                'model': p_model,
                'unique_suffix': p_suffix,
                'cost_price': p_cost,
                'effective_cost': effective_cost,
                'price': p_price,
                'margin_unit': margin_unit,
                'margin_pct': margin_pct,
                'stock': p_stock,
                'supplier': p_supplier,
                'sold_qty': p_sold,
                'revenue': p_rev,
                'daily_sales': round(daily_sales, 2),
                'days_left': days_left,
                'recommended_qty': recommended_qty,
                'calc_formula': calc_formula,
                'estimated_cost': est_cost,
                'estimated_retail': est_retail,
                'abc_class': p_abc,
                'urgency': urgency,
                'urgency_text': urgency_text
            })
            
        conn.close()
        return jsonify({
            'success': True,
            'kpi': {
                'total_items_to_order': len([i for i in items if i['recommended_qty'] > 0]),
                'total_units_to_order': total_rec_units,
                'total_estimated_budget': total_rec_budget,
                'total_estimated_retail': total_rec_retail,
                'total_estimated_margin': max(0.0, total_rec_retail - total_rec_budget),
                'out_of_stock_count': out_of_stock_count,
                'critical_count': critical_count,
                'low_count': low_count,
                'total_displayed': len(items)
            },
            'suppliers': ['all'] + all_suppliers,
            'categories': ['all'] + all_categories,
            'brands': ['all'] + all_brands,
            'models': ['all'] + all_models,
            'suffixes': ['all'] + all_suffixes,
            'items': items
        })
    except Exception as e:
        if conn:
            conn.close()
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500


def get_windows_desktop_directory():
    # 1. Try Windows Shell API (CSIDL_DESKTOPDIRECTORY = 0x0010)
    try:
        import ctypes
        from ctypes import wintypes
        buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
        if ctypes.windll.shell32.SHGetFolderPathW(0, 16, 0, 0, buf) == 0:
            if buf.value and os.path.exists(buf.value):
                return buf.value
    except Exception:
        pass
        
    # 2. Try Windows Registry User Shell Folders
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")
        desktop_reg, _ = winreg.QueryValueEx(key, "Desktop")
        desktop_reg = os.path.expandvars(desktop_reg)
        if os.path.exists(desktop_reg):
            return desktop_reg
    except Exception:
        pass
        
    # 3. Fallbacks for various localizations & OneDrive redirects
    home = os.path.expanduser('~')
    user_profile = os.environ.get('USERPROFILE', home)
    for candidate in [
        os.path.join(home, 'Desktop'),
        os.path.join(user_profile, 'Desktop'),
        os.path.join(home, 'Рабочий стол'),
        os.path.join(user_profile, 'Рабочий стол'),
        os.path.join(home, 'OneDrive', 'Desktop'),
        os.path.join(user_profile, 'OneDrive', 'Desktop'),
        os.path.join(home, 'OneDrive', 'Рабочий стол'),
        os.path.join(user_profile, 'OneDrive', 'Рабочий стол'),
        os.path.join(home, 'Downloads'),
        os.path.join(user_profile, 'Downloads'),
    ]:
        if os.path.exists(candidate):
            return candidate
    return home

@app.route('/api/procurement/export-pdf', methods=['POST'])
def export_procurement_pdf_endpoint():
    try:
        data = request.get_json() or {}
        items = data.get('items', [])
        supplier = data.get('supplier', 'all')
        page_number = data.get('page_number', 1)
        start_index = data.get('start_index', 0)
        
        filtered_items = items
        if not filtered_items:
            return jsonify({'success': False, 'message': 'Нет позиций для экспорта в PDF'}), 400
            
        import io
        import base64
        import html
        import datetime
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        
        # Register Cyrillic Fonts safely
        font_regular = 'Helvetica'
        font_bold = 'Helvetica-Bold'
        
        try:
            registered_fonts = pdfmetrics.getRegisteredFontNames()
            windir = os.environ.get('WINDIR', 'C:/Windows')
            font_candidates_reg = [
                os.path.join(windir, 'Fonts', 'arial.ttf'),
                "C:/Windows/Fonts/arial.ttf",
                os.path.join(windir, 'Fonts', 'tahoma.ttf'),
                os.path.join(windir, 'Fonts', 'segoeui.ttf'),
            ]
            font_candidates_bold = [
                os.path.join(windir, 'Fonts', 'arialbd.ttf'),
                "C:/Windows/Fonts/arialbd.ttf",
                os.path.join(windir, 'Fonts', 'tahomabd.ttf'),
                os.path.join(windir, 'Fonts', 'segoeuib.ttf'),
            ]
            
            found_reg = None
            for p in font_candidates_reg:
                if os.path.exists(p):
                    found_reg = p
                    break
                    
            found_bold = None
            for p in font_candidates_bold:
                if os.path.exists(p):
                    found_bold = p
                    break
                    
            if found_reg:
                if 'ArialCustom' not in registered_fonts:
                    pdfmetrics.registerFont(TTFont('ArialCustom', found_reg))
                font_regular = 'ArialCustom'
                
            if found_bold:
                if 'ArialCustomBold' not in registered_fonts:
                    pdfmetrics.registerFont(TTFont('ArialCustomBold', found_bold))
                font_bold = 'ArialCustomBold'
            elif found_reg:
                font_bold = 'ArialCustom'
        except Exception as font_err:
            print(f"Font registration warning: {font_err}")
            
        # Target export directories
        desktop_dir = get_windows_desktop_directory()
        target_dirs = [desktop_dir]
        
        # Also backup to Downloads if different
        home = os.path.expanduser('~')
        downloads_dir = os.path.join(home, 'Downloads')
        if os.path.exists(downloads_dir) and downloads_dir not in target_dirs:
            target_dirs.append(downloads_dir)
            
        now = datetime.datetime.now()
        now_str = now.strftime('%d.%m.%Y %H:%M')
        now_tag = now.strftime('%Y-%m-%d_%H-%M-%S')
        
        raw_supp_name = supplier.upper() if supplier and supplier != 'all' else 'СВОДНЫЙ ЗАКАЗ'
        supp_clean = "".join(c for c in (supplier if supplier and supplier != 'all' else 'all') if c.isalnum() or c in (' ', '_', '-')).strip().replace(' ', '_')
        filename = f"Zakaz_Zakupka_{supp_clean}_str_{page_number}_{now_tag}.pdf"
        primary_filepath = os.path.join(desktop_dir, filename)
        
        pdf_buffer = io.BytesIO()
        
        doc = SimpleDocTemplate(
            pdf_buffer,
            pagesize=landscape(A4),
            leftMargin=16,
            rightMargin=16,
            topMargin=16,
            bottomMargin=16
        )
        
        styles = getSampleStyleSheet()
        title_style = ParagraphStyle(
            'DocTitle',
            parent=styles['Normal'],
            fontName=font_bold,
            fontSize=13,
            textColor=colors.HexColor('#0f172a'),
            spaceAfter=2
        )
        subtitle_style = ParagraphStyle(
            'DocSubtitle',
            parent=styles['Normal'],
            fontName=font_regular,
            fontSize=8.5,
            textColor=colors.HexColor('#475569'),
            spaceAfter=6
        )
        cell_style = ParagraphStyle(
            'TableCell',
            parent=styles['Normal'],
            fontName=font_regular,
            fontSize=7.2,
            leading=8.5,
            textColor=colors.HexColor('#0f172a')
        )
        cell_bold = ParagraphStyle(
            'TableCellBold',
            parent=styles['Normal'],
            fontName=font_bold,
            fontSize=7.2,
            leading=8.5,
            textColor=colors.HexColor('#0f172a')
        )
        header_style = ParagraphStyle(
            'HeaderStyle',
            parent=styles['Normal'],
            fontName=font_bold,
            fontSize=7.2,
            leading=8.5,
            textColor=colors.white
        )
        
        elements = []
        page_info_str = f" • Страница {page_number}" if page_number else ""
        escaped_supp = html.escape(raw_supp_name)
        elements.append(Paragraph(f"📋 ВЕДОМОСТЬ ЗАКУПКИ И ДЕФИЦИТА ТОВАРОВ — {escaped_supp}{page_info_str}", title_style))
        elements.append(Paragraph(f"📅 Сформировано: {now_str} • Поставщик: <b>{escaped_supp}</b> • Страница: <b>{page_number}</b> • Easy CRM", subtitle_style))
        
        table_data = [[Paragraph(f"<b>{html.escape(t)}</b>", header_style) for t in [
            '№', 'ABC', 'Товар / Артикул / Вариация', 'Категория', 'Поставщик', 'Остаток', 'Продано', 'Запас', 'Закуп (сум)', 'Заказ', 'Сумма (сум)'
        ]]]
        
        t_styles = [
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#162238')),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('ALIGN', (0, 0), (0, -1), 'CENTER'),
            ('ALIGN', (1, 0), (1, -1), 'CENTER'),
            ('ALIGN', (3, 0), (7, -1), 'CENTER'),
            ('ALIGN', (8, 0), (8, -1), 'RIGHT'),
            ('ALIGN', (9, 0), (9, -1), 'CENTER'),
            ('ALIGN', (10, 0), (10, -1), 'RIGHT'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2.5),
            ('TOPPADDING', (0, 0), (-1, -1), 2.5),
            ('LEFTPADDING', (0, 0), (-1, -1), 2.5),
            ('RIGHTPADDING', (0, 0), (-1, -1), 2.5),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#cbd5e1')),
        ]
        
        total_units = 0
        total_budget = 0.0
        
        for idx, item in enumerate(filtered_items, 1):
            row_idx = idx
            display_num = start_index + idx
            stock = int(item.get('stock', 0))
            sold = int(item.get('sold_qty', 0))
            rec_qty = int(item.get('recommended_qty', 0))
            days_left = str(item.get('days_left', 0)) + " дн."
            cost = float(item.get('effective_cost') or item.get('cost_price') or 0.0)
            est_cost = float(item.get('estimated_cost') or (rec_qty * cost))
            abc_class = str(item.get('abc_class', 'C'))
            
            total_units += rec_qty
            total_budget += est_cost
            
            if stock == 0:
                stock_color = colors.HexColor('#fee2e2')
            elif stock <= 2:
                stock_color = colors.HexColor('#fef3c7')
            else:
                stock_color = colors.HexColor('#dcfce7')
                
            t_styles.append(('BACKGROUND', (5, row_idx), (5, row_idx), stock_color))
            t_styles.append(('BACKGROUND', (9, row_idx), (9, row_idx), colors.HexColor('#e0f2fe')))
            
            abc_bg = colors.HexColor('#dcfce7') if abc_class == 'A' else (colors.HexColor('#dbeafe') if abc_class == 'B' else colors.HexColor('#f1f5f9'))
            t_styles.append(('BACKGROUND', (1, row_idx), (1, row_idx), abc_bg))
            
            p_name = html.escape(str(item.get('name', 'Без названия')))
            p_barcode = html.escape(str(item.get('barcode') or ''))
            p_suffix = html.escape(str(item.get('unique_suffix') or ''))
            
            name_parts = [f"<b>{p_name}</b>"]
            if p_barcode:
                name_parts.append(f"<font color='#64748b'>Арт:{p_barcode}</font>")
            if p_suffix:
                name_parts.append(f"<font color='#7c3aed'><b>{p_suffix}</b></font>")
            name_html = " • ".join(name_parts)
            
            brand_cat = html.escape(f"{(item.get('brand') or '').upper()} {item.get('type') or ''}".strip() or '—')
            p_supplier = html.escape(str(item.get('supplier') or '—'))
            
            cost_str = f"{int(cost):,}".replace(',', ' ')
            sum_str = f"{int(est_cost):,}".replace(',', ' ')
            
            table_data.append([
                Paragraph(str(display_num), cell_style),
                Paragraph(f"<b>{html.escape(abc_class)}</b>", cell_bold),
                Paragraph(name_html, cell_style),
                Paragraph(brand_cat, cell_style),
                Paragraph(p_supplier, cell_style),
                Paragraph(f"<b>{stock} шт</b>", cell_bold),
                Paragraph(f"{sold} шт", cell_style),
                Paragraph(days_left, cell_style),
                Paragraph(cost_str, cell_style),
                Paragraph(f"<b>{rec_qty} шт</b>" if rec_qty > 0 else "0", cell_bold),
                Paragraph(f"<b>{sum_str}</b>", cell_bold),
            ])
            
        col_widths = [22, 24, 250, 75, 70, 44, 44, 40, 58, 48, 65]
        table = Table(table_data, colWidths=col_widths, repeatRows=1)
        table.setStyle(TableStyle(t_styles))
        elements.append(table)
        
        elements.append(Spacer(1, 8))
        summary_data = [[
            Paragraph(f"<b>ИТОГО ПО СТРАНИЦЕ {page_number}:</b> {len(filtered_items)} позиций • <b>{total_units:,} шт к заказу</b>".replace(',', ' '), cell_bold),
            Paragraph(f"<b>СУММА К ЗАКУПКЕ:</b> <b>{int(total_budget):,} сум</b>".replace(',', ' '), cell_bold)
        ]]
        sum_table = Table(summary_data, colWidths=[400, 340])
        sum_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#f8fafc')),
            ('BOX', (0, 0), (-1, -1), 1, colors.HexColor('#94a3b8')),
            ('PADDING', (0, 0), (-1, -1), 5),
            ('ALIGN', (1, 0), (1, 0), 'RIGHT'),
        ]))
        elements.append(sum_table)
        
        doc.build(elements)
        pdf_bytes = pdf_buffer.getvalue()
        
        saved_paths = []
        for d in target_dirs:
            try:
                if not os.path.exists(d):
                    os.makedirs(d, exist_ok=True)
                p = os.path.join(d, filename)
                with open(p, 'wb') as f:
                    f.write(pdf_bytes)
                saved_paths.append(p)
            except Exception as save_err:
                print(f"Error saving PDF to {d}: {save_err}")
                
        # Base64 encode for direct browser download
        pdf_base64 = base64.b64encode(pdf_bytes).decode('utf-8')
        
        active_filepath = saved_paths[0] if saved_paths else primary_filepath
        
        return jsonify({
            'success': True,
            'filename': filename,
            'filepath': active_filepath,
            'saved_paths': saved_paths,
            'pdf_base64': pdf_base64,
            'page_number': page_number,
            'total_items': len(filtered_items),
            'total_units': total_units,
            'total_budget': total_budget
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'message': f"Ошибка генерации PDF: {str(e)}"}), 500


@app.route('/api/system/open-file', methods=['POST'])
def open_system_file_endpoint():
    try:
        data = request.get_json() or {}
        filepath = data.get('filepath', '')
        if filepath and os.path.exists(filepath):
            import subprocess
            try:
                os.startfile(filepath)
            except Exception:
                subprocess.Popen(f'explorer.exe /select,"{filepath}"')
            return jsonify({'success': True})
        return jsonify({'success': False, 'message': 'Файл не найден на диске'}), 404
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/system/open-folder', methods=['POST'])
def open_system_folder_endpoint():
    try:
        data = request.get_json() or {}
        filepath = data.get('filepath', '')
        if filepath and os.path.exists(filepath):
            import subprocess
            subprocess.Popen(f'explorer.exe /select,"{filepath}"')
            return jsonify({'success': True})
        elif filepath:
            folder = os.path.dirname(filepath)
            if os.path.exists(folder):
                import subprocess
                subprocess.Popen(f'explorer.exe "{folder}"')
                return jsonify({'success': True})
        return jsonify({'success': False, 'message': 'Папка или файл не найдены'}), 404
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/analytics/category-inflow', methods=['GET'])
def get_category_inflow_endpoint():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        cursor.execute("""
            SELECT 
                p.id,
                COALESCE(NULLIF(TRIM(p.type), ''), 'Без типа') as type_name,
                COALESCE(NULLIF(TRIM(p.brand), ''), 'other') as brand,
                COALESCE(NULLIF(TRIM(p.model), ''), '') as model,
                p.name,
                p.stock as current_stock,
                p.cost_price,
                p.price as retail_price,
                COALESCE(s_agg.sold_qty, 0) as sold_qty,
                COALESCE(s_agg.sold_revenue, 0) as sold_revenue,
                COALESCE(w_agg.write_off_qty, 0) as write_off_qty,
                COALESCE(pu_agg.purchase_qty, 0) as purchase_qty,
                COALESCE(pu_agg.purchase_cost, 0) as purchase_cost
            FROM products p
            LEFT JOIN (
                SELECT product_id, SUM(quantity) as sold_qty, SUM(price_final * quantity) as sold_revenue 
                FROM sales GROUP BY product_id
            ) s_agg ON p.id = s_agg.product_id
            LEFT JOIN (
                SELECT product_id, SUM(quantity) as write_off_qty 
                FROM write_offs GROUP BY product_id
            ) w_agg ON p.id = w_agg.product_id
            LEFT JOIN (
                SELECT product_id, SUM(quantity) as purchase_qty, SUM(quantity * purchase_price) as purchase_cost 
                FROM purchases GROUP BY product_id
            ) pu_agg ON p.id = pu_agg.product_id
            WHERE p.is_deleted = 0
        """)
        products = [dict(r) for r in cursor.fetchall()]
        
        categories = {}
        total_store_initial = 0
        total_store_current = 0
        total_store_sold = 0
        total_store_initial_cost = 0
        
        for p in products:
            c_name = p['type_name']
            if c_name not in categories:
                categories[c_name] = {
                    'type_name': c_name,
                    'unique_skus': 0,
                    'total_initial_qty': 0,
                    'total_initial_cost': 0.0,
                    'total_sold_qty': 0,
                    'total_sold_revenue': 0.0,
                    'total_write_off_qty': 0,
                    'current_stock_qty': 0,
                    'current_stock_cost': 0.0,
                    'current_stock_retail': 0.0,
                    'items': []
                }
                
            cur_stock = p['current_stock'] or 0
            sold_qty = p['sold_qty'] or 0
            wo_qty = p['write_off_qty'] or 0
            
            initial_qty = max(p['purchase_qty'] or 0, cur_stock + sold_qty + wo_qty)
            cost = p['cost_price'] or 0.0
            retail = p['retail_price'] or 0.0
            initial_cost = p['purchase_cost'] if (p['purchase_cost'] and p['purchase_cost'] > 0) else (initial_qty * cost)
            
            categories[c_name]['unique_skus'] += 1
            categories[c_name]['total_initial_qty'] += initial_qty
            categories[c_name]['total_initial_cost'] += initial_cost
            categories[c_name]['total_sold_qty'] += sold_qty
            categories[c_name]['total_sold_revenue'] += (p['sold_revenue'] or 0.0)
            categories[c_name]['total_write_off_qty'] += wo_qty
            categories[c_name]['current_stock_qty'] += cur_stock
            categories[c_name]['current_stock_cost'] += (cur_stock * cost)
            categories[c_name]['current_stock_retail'] += (cur_stock * retail)
            
            total_store_initial += initial_qty
            total_store_current += cur_stock
            total_store_sold += sold_qty
            total_store_initial_cost += initial_cost
            
            categories[c_name]['items'].append({
                'id': p['id'],
                'name': p['name'],
                'brand': p['brand'],
                'model': p['model'],
                'initial_qty': initial_qty,
                'sold_qty': sold_qty,
                'current_stock': cur_stock,
                'cost_price': cost,
                'retail_price': retail
            })

        sorted_cats = sorted(categories.values(), key=lambda x: x['total_initial_qty'], reverse=True)
        for c in sorted_cats:
            init_q = c['total_initial_qty']
            sold_q = c['total_sold_qty']
            c['sell_through_percent'] = round((sold_q / init_q * 100), 1) if init_q > 0 else 0.0
            c['items'].sort(key=lambda x: x['initial_qty'], reverse=True)

        conn.close()
        return jsonify({
            'success': True,
            'summary': {
                'total_categories': len(sorted_cats),
                'total_initial_qty': total_store_initial,
                'total_current_stock': total_store_current,
                'total_sold_qty': total_store_sold,
                'total_initial_cost': total_store_initial_cost,
                'overall_sell_through': round((total_store_sold / total_store_initial * 100), 1) if total_store_initial > 0 else 0.0
            },
            'categories': sorted_cats
        })
    except Exception as e:
        conn.close()
        return jsonify({"success": False, "message": str(e)}), 500


@app.route('/api/dashboard/stats', methods=['GET'])
def get_stats():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    stats = compute_stats_internal(cursor)
    conn.close()
    
    return jsonify({
        "success": True,
        "stats": stats
    })



@app.route('/api/sales/<int:sale_id>/refund', methods=['POST'])
def refund_sale(sale_id):
    data = request.json or {}
    password = data.get('password', '').strip()
    
    is_owner = session.get('owner_logged_in', False)
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        if not is_owner:
            if not password:
                conn.close()
                return jsonify({"success": False, "message": "Пароль владельца обязателен для отмены продажи!"}), 400
                
            cursor.execute("SELECT key, value FROM settings WHERE key IN ('owner_password', 'recovery_password')")
            rows = cursor.fetchall()
            passwords = [r['value'] for r in rows if r and r['value']]
            hashed_input = hash_password(password)
            
            # Verify against owner password hash, recovery password, or plain password
            if not any(hashed_input == p or password == p for p in passwords):
                conn.close()
                return jsonify({"success": False, "message": "Неверный пароль владельца!"}), 401
                
        # Find the sale
        cursor.execute("SELECT product_id, quantity FROM sales WHERE id = ?", (sale_id,))
        sale = cursor.fetchone()
        if not sale:
            conn.close()
            return jsonify({"success": False, "message": "Продажа не найдена"}), 404
            
        product_id = sale['product_id']
        quantity = sale['quantity']
        
        # Increment product stock back in warehouse if product exists
        if product_id is not None:
            cursor.execute("UPDATE products SET stock = stock + ? WHERE id = ?", (quantity, product_id))
        
        # Delete the sale
        cursor.execute("DELETE FROM sales WHERE id = ?", (sale_id,))
        
        conn.commit()
        conn.close()
        invalidate_catalog_cache()
        
        # Automatically trigger report update and Google Drive sync in background thread
        try:
            from threading import Thread
            Thread(target=upload_report_to_gdrive_silent, daemon=True).start()
        except Exception as e:
            print(f"Error starting background sync after refund: {e}")
            
        return jsonify({"success": True, "message": "Возврат успешно оформлен, остаток обновлен!"})
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({"success": False, "message": f"Ошибка при отмене продажи: {str(e)}"}), 500

@app.route('/api/sales/<int:sale_id>/edit', methods=['POST'])
def edit_sale(sale_id):
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    data = request.json or {}
    new_quantity = int(data.get('quantity', 1))
    new_discount = float(data.get('discount_percent', 0.0))
    new_payment = data.get('payment_method', 'cash')
    
    if new_quantity <= 0:
        return jsonify({"success": False, "message": "Количество должно быть больше 0"}), 400
        
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # Get old sale details
        cursor.execute("SELECT product_id, quantity, price_original FROM sales WHERE id = ?", (sale_id,))
        sale = cursor.fetchone()
        if not sale:
            conn.close()
            return jsonify({"success": False, "message": "Продажа не найдена"}), 404
            
        product_id = sale['product_id']
        old_quantity = sale['quantity']
        price_original = sale['price_original']
        
        # Calculate stock adjustment
        qty_diff = new_quantity - old_quantity
        
        # Verify stock availability if increasing quantity
        if qty_diff > 0:
            cursor.execute("SELECT stock FROM products WHERE id = ?", (product_id,))
            prod = cursor.fetchone()
            if not prod or prod['stock'] < qty_diff:
                conn.close()
                return jsonify({"success": False, "message": f"Недостаточно товара на складе! Доступно: {prod['stock'] if prod else 0}"}), 400
                
            cursor.execute("UPDATE products SET stock = stock - ? WHERE id = ?", (qty_diff, product_id))
        elif qty_diff < 0:
            cursor.execute("UPDATE products SET stock = stock + ? WHERE id = ?", (abs(qty_diff), product_id))
            
        # Calculate updated final price
        new_price_final = int(round(price_original * (1 - new_discount / 100)))
        
        # Update sale record
        cursor.execute('''
            UPDATE sales 
            SET quantity = ?, discount_percent = ?, price_final = ?, payment_method = ?
            WHERE id = ?
        ''', (new_quantity, new_discount, new_price_final, new_payment, sale_id))
        
        conn.commit()
        conn.close()
        invalidate_catalog_cache()
        
        # Sync GDrive
        try:
            upload_report_to_gdrive()
        except Exception as e:
            print(f"Error syncing report after sale edit: {e}")
            
        return jsonify({"success": True, "message": "Параметры продажи успешно изменены!"})
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({"success": False, "message": f"Ошибка: {str(e)}"}), 500

@app.route('/api/print', methods=['POST'])
def print_label_backend():
    data = request.json or {}
    barcode_val = str(data.get('barcode', ''))
    name = str(data.get('name', ''))
    price = float(data.get('price', 0.0))
    count = int(data.get('count', 1))

    if not barcode_val:
        return jsonify({"success": False, "message": "Отсутствует штрихкод товара!"})

    try:
        import win32print
        import win32ui
        import win32con
        from PIL import Image, ImageDraw, ImageFont, ImageWin
        from barcode import Code128
        from barcode.writer import ImageWriter

        # 1. Create label image (600x400 pixels for 30x20mm ratio at higher resolution)
        img = Image.new('L', (600, 400), color=255) # 255 is white
        draw = ImageDraw.Draw(img)

        # Load fonts (try bold Windows font first, fallback to standard)
        try:
            font_title = ImageFont.truetype("C:\\Windows\\Fonts\\arialbd.ttf", 30)
            font_price = ImageFont.truetype("C:\\Windows\\Fonts\\arialbd.ttf", 68)
            font_barcode = ImageFont.truetype("C:\\Windows\\Fonts\\arial.ttf", 22)
        except IOError:
            font_title = ImageFont.load_default()
            font_price = ImageFont.load_default()
            font_barcode = ImageFont.load_default()

        # 2. Draw Product Name (Centered, wrapped to 2 lines)
        import textwrap
        lines = textwrap.wrap(name, width=26)
        if len(lines) > 2:
            lines = lines[:2]
            lines[1] = lines[1][:23] + "..."

        if len(lines) == 1:
            current_y = 20
            barcode_y = 80
        else:
            current_y = 8
            barcode_y = 96

        for line in lines:
            bbox_title = draw.textbbox((0, 0), line, font=font_title)
            w_title = bbox_title[2] - bbox_title[0]
            draw.text(((600 - w_title) // 2, current_y), line, fill=0, font=font_title)
            current_y += 36

        # 3. Generate barcode image using python-barcode
        options = {
            'module_width': 0.3,     # 0.3 mm per thin bar (makes it wider and easier to scan)
            'module_height': 6.0,    # 6.0 mm tall lines
            'quiet_zone': 1.0,       # 1.0 mm quiet zone margins
            'write_text': False      # disable built-in text rendering
        }
        rv = Code128(barcode_val, writer=ImageWriter())
        barcode_img = rv.render(options)

        # Maximum barcode width is 580 pixels
        max_barcode_w = 580
        barcode_h = 110
        if barcode_img.width > max_barcode_w:
            scale = max_barcode_w / barcode_img.width
            new_h = int(barcode_img.height * scale)
            barcode_img = barcode_img.resize((max_barcode_w, new_h), Image.Resampling.LANCZOS)
        else:
            scale = barcode_h / barcode_img.height
            new_w = int(barcode_img.width * scale)
            if new_w > max_barcode_w:
                new_w = max_barcode_w
            barcode_img = barcode_img.resize((new_w, barcode_h), Image.Resampling.LANCZOS)

        # Paste barcode image centered
        barcode_x = (600 - barcode_img.width) // 2
        img.paste(barcode_img, (barcode_x, barcode_y))

        # 4. Draw Barcode digits centered under barcode lines
        digits_y = barcode_y + barcode_img.height + 4
        bbox_bar = draw.textbbox((0, 0), barcode_val, font=font_barcode)
        w_bar = bbox_bar[2] - bbox_bar[0]
        draw.text(((600 - w_bar) // 2, digits_y), barcode_val, fill=0, font=font_barcode)

        # 5. Draw Price (Centered)
        price_text = f"{format_currency(price)} сум"
        bbox_price = draw.textbbox((0, 0), price_text, font=font_price)
        w_price = bbox_price[2] - bbox_price[0]
        price_y = digits_y + 30
        # Ensure it doesn't exceed canvas bottom
        if price_y + (bbox_price[3] - bbox_price[1]) > 396:
            price_y = 396 - (bbox_price[3] - bbox_price[1])
        draw.text(((600 - w_price) // 2, price_y), price_text, fill=0, font=font_price)
        
        # 6. Print to Default Windows Printer
        try:
            printer_name = win32print.GetDefaultPrinter()
        except Exception:
            return jsonify({"success": False, "message": "Принтер по умолчанию не найден! Пожалуйста, установите принтер по умолчанию в Windows."})
            
        # Auto-resume printer if it is paused (requires PRINTER_ALL_ACCESS)
        try:
            hprinter_admin = win32print.OpenPrinter(printer_name, {'DesiredAccess': win32print.PRINTER_ALL_ACCESS})
            info = win32print.GetPrinter(hprinter_admin, 2)
            # PRINTER_STATUS_PAUSED is 1
            if info.get('Status', 0) & 1:
                win32print.SetPrinter(hprinter_admin, 0, None, win32print.PRINTER_CONTROL_RESUME)
            win32print.ClosePrinter(hprinter_admin)
        except Exception:
            pass

        hprinter = win32print.OpenPrinter(printer_name)
        try:
            hdc = win32ui.CreateDC()
            hdc.CreatePrinterDC(printer_name)
            
            for _ in range(count):
                hdc.StartDoc("CRM Sticker Job")
                hdc.StartPage()
                
                printable_width = hdc.GetDeviceCaps(win32con.PHYSICALWIDTH)
                printable_height = hdc.GetDeviceCaps(win32con.PHYSICALHEIGHT)
                
                # Render bitmap image to Printer DC
                dib = ImageWin.Dib(img)
                dib.draw(hdc.GetHandleOutput(), (0, 0, printable_width, printable_height))
                
                hdc.EndPage()
                hdc.EndDoc()
        finally:
            win32print.ClosePrinter(hprinter)
            
        return jsonify({"success": True})
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "message": f"Ошибка печати: {str(e)}"})

# =====================================================================
# --- GOOGLE DRIVE SYNCHRONIZATION & MOBILE REPORTING ---
# =====================================================================

OAUTH_SUCCESS_HTML = """<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Google Диск подключен!</title>
    <style>
        body {
            background-color: #090a0f;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
        }
        .container {
            text-align: center;
            background: rgba(18, 20, 32, 0.7);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 24px;
            padding: 40px;
            max-width: 450px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }
        h1 {
            color: #00e676;
            margin-bottom: 20px;
        }
        p {
            color: #a0aec0;
            line-height: 1.5;
            margin-bottom: 30px;
        }
        .btn {
            background: linear-gradient(135deg, #1a73e8, #7c4dff);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 12px;
            font-weight: bold;
            cursor: pointer;
            text-decoration: none;
            font-size: 1rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Google Диск успешно подключен!</h1>
        <p>Вы успешно авторизовали CRM-систему. Теперь вы можете закрыть эту вкладку браузера и вернуться в панель управления Easy CRM.</p>
        <button class="btn" onclick="window.close()">Закрыть окно</button>
    </div>
</body>
</html>
"""

def generate_report_html():
    conn = get_db_connection()
    cursor = conn.cursor()
    stats = compute_stats_internal(cursor)
    conn.close()
    
    sales_by_day_json = json.dumps(stats.get("sales_by_day", []))
    today_sales_by_type_json = json.dumps(stats.get("today", {}).get("sales_by_type", []))
    
    stagnant_rows_html = ""
    for p in stats.get("stagnant_products", []):
        last_sale = p['last_sale'] if p['last_sale'] else "Нет продаж"
        stagnant_rows_html += f"""
        <tr>
            <td style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.06); font-family: monospace;">{p['barcode']}</td>
            <td style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.06); font-weight: 500;">{p['name']}</td>
            <td style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.06); text-align: center;">{p['stock']} шт.</td>
            <td style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.06); text-align: right; color: var(--text-secondary); font-size: 0.85rem;">{last_sale}</td>
        </tr>
        """
    if not stagnant_rows_html:
        stagnant_rows_html = "<tr><td colspan='4' style='text-align: center; color: var(--text-secondary); padding: 20px;'>Все товары активно продаются!</td></tr>"

    today_sales_html = ""
    for s in stats.get("today", {}).get("sales_list", []):
        formatted_time = s['sold_at']
        try:
            formatted_time = formatted_time.split(" ")[1]
        except Exception:
            pass
        discount_badge = f"<span style='background: rgba(255, 61, 0, 0.15); color: #ff3d00; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; margin-right: 6px;'>-{s['discount_percent']}%</span>" if s['discount_percent'] > 0 else ""
        today_sales_html += f"""
        <tr>
            <td style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.06); color: var(--text-secondary); font-size: 0.85rem;">{formatted_time}</td>
            <td style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.06); font-weight: 500;">{s['product_name']}</td>
            <td style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.06); text-align: center;">{s['quantity']} шт.</td>
            <td style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.06); text-align: right; font-weight: bold; color: var(--color-success);">{format_currency(s['price_final'] * s['quantity'])} сум<br><small style='font-weight: 500; font-size:0.75rem; color: var(--text-secondary);'>{discount_badge}</small></td>
        </tr>
        """
    if not today_sales_html:
        today_sales_html = "<tr><td colspan='4' style='text-align: center; color: var(--text-secondary); padding: 20px;'>Продаж сегодня еще не было</td></tr>"

    inv_cost = stats.get("inventory_value", {}).get("cost", 0.0)
    inv_sell = stats.get("inventory_value", {}).get("selling", 0.0)
    expected_profit = stats.get("inventory_value", {}).get("expected_profit", 0.0)

    html = f"""<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Easy CRM - Аналитический отчет</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {{
            --bg-color: #090a0f;
            --panel-bg: rgba(18, 20, 32, 0.7);
            --border-color: rgba(255, 255, 255, 0.08);
            --text-primary: #ffffff;
            --text-secondary: #a0aec0;
            --color-primary: #7c4dff;
            --color-success: #00e676;
            --color-warning: #ffb300;
        }}
        * {{
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }}
        body {{
            background-color: var(--bg-color);
            color: var(--text-primary);
            font-family: 'Outfit', sans-serif;
            padding: 20px;
            min-height: 100vh;
        }}
        .container {{
            max-width: 800px;
            margin: 0 auto;
        }}
        header {{
            display: flex;
            flex-direction: column;
            gap: 5px;
            margin-bottom: 25px;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 15px;
        }}
        h1 {{
            font-size: 1.8rem;
            font-weight: 800;
            background: linear-gradient(135deg, #1a73e8, #7c4dff);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }}
        .timestamp {{
            font-size: 0.85rem;
            color: var(--text-secondary);
        }}
        .widgets-grid {{
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-bottom: 25px;
        }}
        .widget-card {{
            background: var(--panel-bg);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 15px 20px;
            display: flex;
            flex-direction: column;
            gap: 5px;
        }}
        .widget-title {{
            font-size: 0.8rem;
            color: var(--text-secondary);
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }}
        .widget-value {{
            font-size: 1.4rem;
            font-weight: 800;
        }}
        .card {{
            background: var(--panel-bg);
            border: 1px solid var(--border-color);
            border-radius: 20px;
            padding: 20px;
            margin-bottom: 25px;
        }}
        h2 {{
            font-size: 1.2rem;
            font-weight: 700;
            margin-bottom: 15px;
            color: #fff;
            border-left: 4px solid var(--color-primary);
            padding-left: 10px;
        }}
        .chart-container {{
            position: relative;
            height: 250px;
            width: 100%;
            margin-bottom: 15px;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
            font-size: 0.9rem;
        }}
        th {{
            text-align: left;
            padding: 10px 12px;
            color: var(--text-secondary);
            font-weight: 600;
            border-bottom: 2px solid var(--border-color);
        }}
        .table-responsive {{
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
        }}
        .expected-profit-banner {{
            display: flex;
            justify-content: space-between;
            background: rgba(0, 230, 118, 0.08);
            border: 1px dashed var(--color-success);
            padding: 12px 16px;
            border-radius: 12px;
            margin-top: 15px;
            font-size: 0.9rem;
        }}
        @media (max-width: 576px) {{
            .widgets-grid {{
                grid-template-columns: 1fr;
            }}
            body {{
                padding: 10px;
            }}
            .widget-value {{
                font-size: 1.25rem;
            }}
        }}
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Easy CRM Analytics</h1>
            <div class="timestamp">Отчет обновлен: {time.strftime('%d.%m.%Y %H:%M:%S', time.localtime())}</div>
        </header>

        <!-- Metrics widgets -->
        <div class="widgets-grid">
            <div class="widget-card">
                <span class="widget-title">Выручка за сегодня</span>
                <span class="widget-value" style="color: #fff;">{format_currency(stats['today']['revenue'])} сум</span>
            </div>
            <div class="widget-card">
                <span class="widget-title">Прибыль за сегодня</span>
                <span class="widget-value" style="color: var(--color-success);">{format_currency(stats['today']['profit'])} сум</span>
            </div>
            <div class="widget-card">
                <span class="widget-title">Выручка за все время</span>
                <span class="widget-value" style="color: #fff;">{format_currency(stats['all_time']['revenue'])} сум</span>
            </div>
            <div class="widget-card">
                <span class="widget-title">Прибыль за все время</span>
                <span class="widget-value" style="color: var(--color-success);">{format_currency(stats['all_time']['profit'])} сум</span>
            </div>
        </div>

        <!-- Inventory values -->
        <div class="card">
            <h2>Оценка склада и ресурсов</h2>
            <div style="display: flex; flex-direction: column; gap: 10px; font-size: 0.95rem;">
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--text-secondary);">Оценка по себестоимости:</span>
                    <span style="font-weight: bold; color: var(--color-primary);">{format_currency(inv_cost)} сум</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--text-secondary);">Оценка по цене продажи:</span>
                    <span style="font-weight: bold; color: #fff;">{format_currency(inv_sell)} сум</span>
                </div>
                <div class="expected-profit-banner">
                    <span style="font-weight: bold; color: var(--color-success);">Ожидаемая чистая прибыль:</span>
                    <span style="font-weight: 800; color: var(--color-success);">{format_currency(expected_profit)} сум</span>
                </div>
            </div>
        </div>

        <!-- Sales Chart -->
        <div class="card">
            <h2>Динамика выручки (последние 7 дней)</h2>
            <div class="chart-container">
                <canvas id="salesChart"></canvas>
            </div>
        </div>

        <!-- Category Distribution -->
        <div class="card">
            <h2>Распределение продаж за сегодня</h2>
            <div class="chart-container" style="height: 220px;">
                <canvas id="categoryChart"></canvas>
            </div>
        </div>

        <!-- Today Sales List -->
        <div class="card">
            <h2>Продажи за смену (сегодня)</h2>
            <div class="table-responsive">
                <table>
                    <thead>
                        <tr>
                            <th>Время</th>
                            <th>Товар</th>
                            <th style="text-align: center;">Кол-во</th>
                            <th style="text-align: right;">Сумма</th>
                        </tr>
                    </thead>
                    <tbody>
                        {today_sales_html}
                    </tbody>
                </table>
            </div>
        </div>

        <!-- Stagnant products -->
        <div class="card" style="margin-bottom: 50px;">
            <h2>Залежавшиеся товары (давно не продавались)</h2>
            <div class="table-responsive">
                <table>
                    <thead>
                        <tr>
                            <th>Код</th>
                            <th>Товар</th>
                            <th style="text-align: center;">Остаток</th>
                            <th style="text-align: right;">Последняя продажа</th>
                        </tr>
                    </thead>
                    <tbody>
                        {stagnant_rows_html}
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        const salesByDay = {sales_by_day_json};
        const salesByType = {today_sales_by_type_json};

        // Render Sales Chart
        const ctxSales = document.getElementById('salesChart').getContext('2d');
        const labelsSales = salesByDay.map(d => {{
            const parts = d.date.split('-');
            return parts.length === 3 ? parts[2] + '.' + parts[1] : d.date;
        }});
        new Chart(ctxSales, {{
            type: 'line',
            data: {{
                labels: labelsSales,
                datasets: [
                    {{
                        label: 'Выручка (сум)',
                        data: salesByDay.map(d => d.revenue),
                        borderColor: '#7c4dff',
                        backgroundColor: 'rgba(124, 77, 255, 0.1)',
                        borderWidth: 2,
                        tension: 0.3,
                        fill: true
                    }},
                    {{
                        label: 'Прибыль (сум)',
                        data: salesByDay.map(d => d.profit),
                        borderColor: '#00e676',
                        backgroundColor: 'rgba(0, 230, 118, 0.05)',
                        borderWidth: 2,
                        tension: 0.3,
                        fill: true
                    }}
                ]
            }},
            options: {{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {{
                    legend: {{ labels: {{ color: '#fff' }} }}
                }},
                scales: {{
                    x: {{ grid: {{ color: 'rgba(255,255,255,0.05)' }}, ticks: {{ color: '#a0aec0' }} }},
                    y: {{ grid: {{ color: 'rgba(255,255,255,0.05)' }}, ticks: {{ color: '#a0aec0' }} }}
                }}
            }}
        }});

        // Render Category Chart
        const ctxCat = document.getElementById('categoryChart').getContext('2d');
        if (salesByType.length === 0) {{
            ctxCat.font = '14px Outfit';
            ctxCat.fillStyle = '#a0aec0';
            ctxCat.textAlign = 'center';
            ctxCat.fillText('Нет продаж по категориям за сегодня', ctxCat.canvas.width / 2, ctxCat.canvas.height / 2);
        }} else {{
            new Chart(ctxCat, {{
                type: 'doughnut',
                data: {{
                    labels: salesByType.map(t => t.type_name),
                    datasets: [{{
                        data: salesByType.map(t => t.revenue),
                        backgroundColor: [
                            '#7c4dff', '#00e676', '#ffb300', '#00e5ff', '#ff1744', '#d500f9'
                        ],
                        borderWidth: 0
                    }}]
                }},
                options: {{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {{
                        legend: {{
                            position: 'right',
                            labels: {{ color: '#fff', boxWidth: 12 }}
                        }}
                    }}
                }}
            }});
        }}
    </script>
</body>
</html>
"""
    return html

def upload_report_to_gdrive():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_id'")
    r = cursor.fetchone()
    client_id = r[0] if r else None
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_secret'")
    r = cursor.fetchone()
    client_secret = r[0] if r else None
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_refresh_token'")
    r = cursor.fetchone()
    refresh_token = r[0] if r else None
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_file_id'")
    r = cursor.fetchone()
    file_id = r[0] if r else None
    
    conn.close()
    
    if not client_id or not client_secret or not refresh_token:
        raise Exception("Google Drive OAuth is not configured/authorized yet.")
        
    token_url = "https://oauth2.googleapis.com/token"
    token_data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token"
    }).encode("utf-8")
    
    req = urllib.request.Request(token_url, data=token_data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req) as res:
        res_data = json.loads(res.read().decode("utf-8"))
        access_token = res_data["access_token"]
        
    html_report = generate_report_html()
    
    if not file_id:
        search_url = "https://www.googleapis.com/drive/v3/files?q=" + urllib.parse.quote("name='CRM_Analytics.html' and trashed=false")
        search_req = urllib.request.Request(search_url, headers={"Authorization": f"Bearer {access_token}"})
        try:
            with urllib.request.urlopen(search_req) as search_res:
                search_data = json.loads(search_res.read().decode("utf-8"))
                files = search_data.get("files", [])
                if files:
                    file_id = files[0]["id"]
                    conn = get_db_connection()
                    cursor = conn.cursor()
                    cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('gdrive_file_id', ?)", (file_id,))
                    conn.commit()
                    conn.close()
        except Exception as e:
            print(f"Error searching for file: {e}")
            
    if not file_id:
        create_url = "https://www.googleapis.com/drive/v3/files"
        create_data = json.dumps({
            "name": "CRM_Analytics.html",
            "mimeType": "text/html"
        }).encode("utf-8")
        
        create_req = urllib.request.Request(create_url, data=create_data, headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json"
        })
        with urllib.request.urlopen(create_req) as create_res:
            create_data_res = json.loads(create_res.read().decode("utf-8"))
            file_id = create_data_res["id"]
            
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('gdrive_file_id', ?)", (file_id,))
        conn.commit()
        conn.close()
        
        perm_url = f"https://www.googleapis.com/drive/v3/files/{file_id}/permissions"
        perm_data = json.dumps({
            "role": "reader",
            "type": "anyone"
        }).encode("utf-8")
        
        perm_req = urllib.request.Request(perm_url, data=perm_data, headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json"
        })
        try:
            with urllib.request.urlopen(perm_req) as perm_res:
                pass
        except Exception as e:
            print(f"Error setting public permission: {e}")
            
    upload_url = f"https://www.googleapis.com/upload/drive/v3/files/{file_id}?uploadType=media"
    upload_req = urllib.request.Request(upload_url, data=html_report.encode("utf-8"), headers={
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "text/html"
    }, method="PATCH")
    
    try:
        with urllib.request.urlopen(upload_req) as upload_res:
            pass
    except urllib.error.HTTPError as he:
        if he.code == 404:
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("DELETE FROM settings WHERE key = 'gdrive_file_id'")
            conn.commit()
            conn.close()
            return upload_report_to_gdrive()
        else:
            raise he
        
    sync_time_str = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('gdrive_last_sync', ?)", (sync_time_str,))

    conn.commit()
    conn.close()
    
    return file_id

def run_background_sync():
    thread = Thread(target=upload_report_to_gdrive_silent)
    thread.daemon = True
    thread.start()

def upload_report_to_gdrive_silent():
    try:
        upload_report_to_gdrive()
    except Exception as e:
        print(f"Background Google Drive Sync failed: {e}")

def log_gdrive_operation(message):
    try:
        log_path = os.path.join(app_data_dir, 'gdrive_operations.log')
        timestamp = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())
        with open(log_path, 'a', encoding='utf-8') as f:
            f.write(f"[{timestamp}] {message}\n")
    except Exception:
        pass

def get_or_create_gdrive_folder(access_token, folder_name="backup data"):
    log_gdrive_operation(f"get_or_create_gdrive_folder: Searching for folder '{folder_name}'...")
    # Search for folder
    query = f"name='{folder_name}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    search_url = "https://www.googleapis.com/drive/v3/files?q=" + urllib.parse.quote(query)
    search_req = urllib.request.Request(search_url, headers={"Authorization": f"Bearer {access_token}"})
    try:
        with urllib.request.urlopen(search_req) as search_res:
            search_data = json.loads(search_res.read().decode("utf-8"))
            files = search_data.get("files", [])
            if files:
                folder_id = files[0]["id"]
                log_gdrive_operation(f"get_or_create_gdrive_folder: Found folder '{folder_name}' with ID: {folder_id}")
                return folder_id
    except Exception as e:
        log_gdrive_operation(f"get_or_create_gdrive_folder: Error searching for folder '{folder_name}': {e}")
        print(f"Error searching for folder '{folder_name}': {e}")
        
    log_gdrive_operation(f"get_or_create_gdrive_folder: Folder '{folder_name}' not found. Creating a new one...")
    # Create folder
    create_url = "https://www.googleapis.com/drive/v3/files"
    create_data = json.dumps({
        "name": folder_name,
        "mimeType": "application/vnd.google-apps.folder"
    }).encode("utf-8")
    create_req = urllib.request.Request(create_url, data=create_data, headers={
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    })
    try:
        with urllib.request.urlopen(create_req) as create_res:
            create_res_data = json.loads(create_res.read().decode("utf-8"))
            folder_id = create_res_data["id"]
            log_gdrive_operation(f"get_or_create_gdrive_folder: Created folder '{folder_name}' with ID: {folder_id}")
            return folder_id
    except Exception as e:
        log_gdrive_operation(f"get_or_create_gdrive_folder: Failed to create folder '{folder_name}': {e}")
        raise Exception(f"Failed to create Google Drive folder '{folder_name}': {e}")

def upload_db_to_gdrive(access_token, db_file_path, folder_id, file_name):
    log_gdrive_operation(f"upload_db_to_gdrive: Uploading '{file_name}' to folder ID '{folder_id}'...")
    boundary = "-------easycrmbackupboundary"
    
    metadata = {
        "name": file_name,
        "parents": [folder_id]
    }
    
    with open(db_file_path, "rb") as f:
        file_content = f.read()
        
    log_gdrive_operation(f"upload_db_to_gdrive: Read '{db_file_path}' (size: {len(file_content)} bytes)")
    
    metadata_part = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
    ).encode("utf-8")
    
    file_part_header = (
        f"--{boundary}\r\n"
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode("utf-8")
    
    footer = f"\r\n--{boundary}--".encode("utf-8")
    
    body = metadata_part + file_part_header + file_content + footer
    
    upload_url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart"
    upload_req = urllib.request.Request(upload_url, data=body, headers={
        "Authorization": f"Bearer {access_token}",
        "Content-Type": f"multipart/related; boundary={boundary}"
    })
    
    try:
        with urllib.request.urlopen(upload_req) as upload_res:
            res_data = json.loads(upload_res.read().decode("utf-8"))
            file_id = res_data["id"]
            log_gdrive_operation(f"upload_db_to_gdrive: Upload complete. File ID: {file_id}")
            return file_id
    except Exception as e:
        log_gdrive_operation(f"upload_db_to_gdrive: Upload exception: {e}")
        raise

def run_gdrive_backup_internal(is_manual=False):
    log_gdrive_operation(f"run_gdrive_backup_internal: Starting backup (is_manual={is_manual})")
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_id'")
    r = cursor.fetchone()
    client_id = r[0] if r else None
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_secret'")
    r = cursor.fetchone()
    client_secret = r[0] if r else None
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_refresh_token'")
    r = cursor.fetchone()
    refresh_token = r[0] if r else None
    
    conn.close()
    
    if not client_id or not client_secret or not refresh_token:
        msg = "Google Drive is not configured or authorized. Skipping backup."
        log_gdrive_operation(msg)
        if is_manual:
            raise Exception("Google Диск не настроен или авторизация отсутствует. Подключите его в настройках.")
        print(msg)
        return
        
    try:
        # Get access token
        log_gdrive_operation("run_gdrive_backup_internal: Requesting OAuth access token...")
        token_url = "https://oauth2.googleapis.com/token"
        token_data = urllib.parse.urlencode({
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token"
        }).encode("utf-8")
        
        req = urllib.request.Request(token_url, data=token_data, headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req) as res:
            res_data = json.loads(res.read().decode("utf-8"))
            access_token = res_data["access_token"]
            log_gdrive_operation("run_gdrive_backup_internal: Received access token successfully.")
            
        # Get or create 'backup data' folder
        folder_id = get_or_create_gdrive_folder(access_token, "backup data")
        
        # Create hot copy of DB using VACUUM INTO
        temp_backup_path = db_path + ".tmp_backup"
        log_gdrive_operation(f"run_gdrive_backup_internal: Creating database hot copy at '{temp_backup_path}'...")
        if os.path.exists(temp_backup_path):
            try:
                os.remove(temp_backup_path)
            except Exception:
                pass
                
        conn = get_db_connection()
        try:
            conn.execute(f"VACUUM INTO '{temp_backup_path.replace('\\', '\\\\')}'")
            log_gdrive_operation("run_gdrive_backup_internal: Database VACUUM INTO completed.")
        finally:
            conn.close()
            
        # Name the backup file with date and time
        timestamp_str = time.strftime('%Y-%m-%d_%H-%M-%S', time.localtime())
        backup_filename = f"easy_crm_backup_{timestamp_str}.db"
        
        # Upload to Drive
        upload_db_to_gdrive(access_token, temp_backup_path, folder_id, backup_filename)
        
        # Cleanup temp copy
        if os.path.exists(temp_backup_path):
            try:
                os.remove(temp_backup_path)
            except Exception:
                pass
                
        # Save last backup time in settings
        backup_time_str = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())
        conn = get_db_connection()
        try:
            with conn:
                cursor = conn.cursor()
                cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('gdrive_last_backup', ?)", (backup_time_str,))
        finally:
            conn.close()
            
        log_gdrive_operation(f"run_gdrive_backup_internal: Backup completed and uploaded: {backup_filename}")
        print(f"Backup completed and uploaded successfully: {backup_filename}")
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        log_gdrive_operation(f"run_gdrive_backup_internal: EXCEPTION OCCURRED:\n{tb}")
        raise Exception(f"Ошибка резервного копирования: {str(e)}")

# --- EMERGENCY RESTORE AND MANUAL BACKUP ENDPOINTS ---

@app.route('/api/gdrive/backup_now', methods=['POST'])
def trigger_manual_backup():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
    try:
        run_gdrive_backup_internal(is_manual=True)
        
        # Fetch new last backup time
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_last_backup'")
        r = cursor.fetchone()
        last_backup = r[0] if r else "Никогда"
        conn.close()
        
        return jsonify({"success": True, "message": "Резервная копия успешно создана и сохранена на Google Диск.", "last_backup": last_backup})
    except Exception as e:
        return jsonify({"success": False, "message": f"Ошибка резервного копирования: {str(e)}"}), 500

@app.route('/api/gdrive/backups', methods=['GET'])
def list_gdrive_backups():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_id'")
    r = cursor.fetchone()
    client_id = r[0] if r else None
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_secret'")
    r = cursor.fetchone()
    client_secret = r[0] if r else None
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_refresh_token'")
    r = cursor.fetchone()
    refresh_token = r[0] if r else None
    
    # Also fetch last backup time for display
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_last_backup'")
    rb = cursor.fetchone()
    last_backup = rb[0] if rb else "Никогда"
    conn.close()
    
    if not client_id or not client_secret or not refresh_token:
        return jsonify({"success": True, "backups": [], "last_backup": last_backup, "configured": False})
        
    try:
        # Get access token
        token_url = "https://oauth2.googleapis.com/token"
        token_data = urllib.parse.urlencode({
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token"
        }).encode("utf-8")
        req = urllib.request.Request(token_url, data=token_data, headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req) as res:
            access_token = json.loads(res.read().decode("utf-8"))["access_token"]
            
        # Get 'backup data' folder ID
        folder_id = get_or_create_gdrive_folder(access_token, "backup data")
        
        # List files inside this folder
        query = f"'{folder_id}' in parents and name contains 'easy_crm_backup_' and name contains '.db' and trashed=false"
        list_url = "https://www.googleapis.com/drive/v3/files?q=" + urllib.parse.quote(query) + "&fields=" + urllib.parse.quote("files(id,name,createdTime)") + "&orderBy=" + urllib.parse.quote("name desc")
        list_req = urllib.request.Request(list_url, headers={"Authorization": f"Bearer {access_token}"})
        
        with urllib.request.urlopen(list_req) as list_res:
            files = json.loads(list_res.read().decode("utf-8")).get("files", [])
            
        return jsonify({"success": True, "backups": files, "last_backup": last_backup, "configured": True})
    except Exception as e:
        return jsonify({"success": False, "message": f"Ошибка загрузки списка резервных копий: {str(e)}"}), 500

@app.route('/api/gdrive/restore', methods=['POST'])
def restore_gdrive_backup():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    data = request.json or {}
    file_id = data.get("file_id")
    password_input = data.get("password", "").strip()
    
    if not file_id:
        return jsonify({"success": False, "message": "Не выбран файл для восстановления"}), 400
        
    # Get recovery password
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM settings WHERE key = 'recovery_password'")
    r = cursor.fetchone()
    expected_password = r[0] if r else "RESTORE-CRM"
    
    if password_input != expected_password:
        conn.close()
        return jsonify({"success": False, "message": "Неверный пароль восстановления!"}), 403
        
    # Get tokens
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_id'")
    client_id = cursor.fetchone()[0]
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_secret'")
    client_secret = cursor.fetchone()[0]
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_refresh_token'")
    refresh_token = cursor.fetchone()[0]
    conn.close()
    
    try:
        # Get access token
        token_url = "https://oauth2.googleapis.com/token"
        token_data = urllib.parse.urlencode({
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token"
        }).encode("utf-8")
        req = urllib.request.Request(token_url, data=token_data, headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req) as res:
            access_token = json.loads(res.read().decode("utf-8"))["access_token"]
            
        # Download backup file
        download_url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media"
        download_req = urllib.request.Request(download_url, headers={"Authorization": f"Bearer {access_token}"})
        
        temp_restore_path = db_path + ".tmp_restore"
        with urllib.request.urlopen(download_req) as res:
            with open(temp_restore_path, "wb") as f:
                f.write(res.read())
                
        # Validate the downloaded DB file
        validation_conn = sqlite3.connect(temp_restore_path)
        try:
            val_cursor = validation_conn.cursor()
            val_cursor.execute("SELECT COUNT(*) FROM products WHERE is_deleted = 0")
            val_cursor.fetchone()
        except Exception:
            validation_conn.close()
            if os.path.exists(temp_restore_path):
                os.remove(temp_restore_path)
            return jsonify({"success": False, "message": "Файл резервной копии поврежден или не является базой данных SQLite!"}), 400
        finally:
            validation_conn.close()
            
        # Database is valid. Rename file.
        bak_db_path = db_path + ".bak"
        if os.path.exists(bak_db_path):
            os.remove(bak_db_path)
            
        # Rename live to backup, and temp to live
        os.rename(db_path, bak_db_path)
        os.rename(temp_restore_path, db_path)
        
        # Re-initialize DB settings
        load_secret_key()
        
        return jsonify({"success": True, "message": "База данных успешно восстановлена! Приложение перезапустится."})
    except Exception as e:
        return jsonify({"success": False, "message": f"Ошибка во время восстановления: {str(e)}"}), 500

def gdrive_sync_loop():
    while True:
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            
            cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_sync_interval'")
            r = cursor.fetchone()
            interval = r[0] if r else "Off"
            
            cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_last_sync'")
            r = cursor.fetchone()
            last_sync_str = r[0] if r else None
            
            cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_last_backup'")
            r = cursor.fetchone()
            last_backup_str = r[0] if r else None
            
            conn.close()
            
            if interval.isdigit():
                minutes = int(interval)
                should_sync = False
                
                if not last_sync_str:
                    should_sync = True
                else:
                    last_sync_time = time.strptime(last_sync_str, '%Y-%m-%d %H:%M:%S')
                    elapsed_seconds = time.time() - time.mktime(last_sync_time)
                    if elapsed_seconds >= (minutes * 60):
                        should_sync = True
                        
                if should_sync:
                    print(f"Periodic background sync triggered (every {minutes} minutes)...")
                    try:
                        upload_report_to_gdrive()
                    except Exception as e:
                        print(f"Background Google Drive Sync failed: {e}")
            
            if interval != "Off":
                should_backup = False
                if not last_backup_str:
                    should_backup = True
                else:
                    try:
                        last_backup_time = time.strptime(last_backup_str, '%Y-%m-%d %H:%M:%S')
                        elapsed_backup = time.time() - time.mktime(last_backup_time)
                        if elapsed_backup >= 3600:
                            should_backup = True
                    except Exception:
                        should_backup = True
                        
                if should_backup:
                    print("Periodic background backup triggered (hourly)...")
                    try:
                        run_gdrive_backup_internal()
                    except Exception as e:
                        print(f"Background Google Drive Backup failed: {e}")
        except Exception as e:
            print(f"Background Google Drive Sync loop error: {e}")
        time.sleep(60)

# --- GOOGLE DRIVE WEB ENDPOINTS ---

@app.route('/api/gdrive/settings', methods=['GET', 'POST'])
def gdrive_settings():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    if request.method == 'POST':
        data = request.json or {}
        client_id = data.get("client_id", "").strip()
        client_secret = data.get("client_secret", "").strip()
        sync_interval = data.get("sync_interval", "Off").strip()
        recovery_password = data.get("recovery_password", "RESTORE-CRM").strip()
        if not recovery_password:
            recovery_password = "RESTORE-CRM"
        
        cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('gdrive_client_id', ?)", (client_id,))
        cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('gdrive_client_secret', ?)", (client_secret,))
        cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('gdrive_sync_interval', ?)", (sync_interval,))
        cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('recovery_password', ?)", (recovery_password,))
        conn.commit()
        conn.close()
        return jsonify({"success": True})
    else:
        cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_id'")
        r = cursor.fetchone()
        client_id = r[0] if r else ""
        
        cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_secret'")
        r = cursor.fetchone()
        client_secret = r[0] if r else ""
        
        cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_sync_interval'")
        r = cursor.fetchone()
        sync_interval = r[0] if r else "Off"
        
        cursor.execute("SELECT value FROM settings WHERE key = 'recovery_password'")
        r = cursor.fetchone()
        recovery_password = r[0] if r else "RESTORE-CRM"
        
        conn.close()
        return jsonify({
            "success": True,
            "client_id": client_id,
            "client_secret": client_secret,
            "sync_interval": sync_interval,
            "recovery_password": recovery_password
        })

@app.route('/api/gdrive/status', methods=['GET'])
def gdrive_status():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_id'")
    r = cursor.fetchone()
    client_id = r[0] if r else None
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_secret'")
    r = cursor.fetchone()
    client_secret = r[0] if r else None
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_refresh_token'")
    r = cursor.fetchone()
    refresh_token = r[0] if r else None
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_file_id'")
    r = cursor.fetchone()
    file_id = r[0] if r else None
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_last_sync'")
    r = cursor.fetchone()
    last_sync = r[0] if r else "Никогда"
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_last_backup'")
    r = cursor.fetchone()
    last_backup = r[0] if r else "Никогда"
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_email'")
    r = cursor.fetchone()
    email = r[0] if r else ""
    
    conn.close()
    
    if not client_id or not client_secret or not refresh_token:
        return jsonify({
            "success": True,
            "connected": False,
            "email": "",
            "last_sync": "Никогда",
            "last_backup": "Никогда",
            "link": ""
        })
        
    link = f"https://drive.google.com/file/d/{file_id}/view?usp=sharing" if file_id else ""
    return jsonify({
        "success": True,
        "connected": True,
        "email": email,
        "last_sync": last_sync,
        "last_backup": last_backup,
        "link": link
    })

@app.route('/api/gdrive/auth-url', methods=['GET'])
def gdrive_auth_url():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_id'")
    r = cursor.fetchone()
    client_id = r[0] if r else None
    conn.close()
    
    if not client_id:
        return jsonify({"success": False, "message": "Сначала введите Google Client ID в настройках"}), 400
        
    redirect_uri = request.host_url + 'api/gdrive/oauth-callback'
    scopes = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email"
    auth_url = (
        "https://accounts.google.com/o/oauth2/v2/auth?"
        f"client_id={client_id}&"
        f"redirect_uri={urllib.parse.quote(redirect_uri)}&"
        "response_type=code&"
        f"scope={urllib.parse.quote(scopes)}&"
        "access_type=offline&"
        "prompt=consent"
    )
    return jsonify({"success": True, "url": auth_url})

@app.route('/api/gdrive/oauth-callback', methods=['GET'])
def gdrive_oauth_callback():
    code = request.args.get('code')
    if not code:
        return "Ошибка: Не удалось получить код авторизации от Google.", 400
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_id'")
    r = cursor.fetchone()
    client_id = r[0] if r else None
    
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_secret'")
    r = cursor.fetchone()
    client_secret = r[0] if r else None
    
    if not client_id or not client_secret:
        conn.close()
        return "Ошибка: Google Client ID и Secret не найдены в базе.", 400
        
    redirect_uri = request.host_url + 'api/gdrive/oauth-callback'
    
    try:
        token_url = "https://oauth2.googleapis.com/token"
        token_data = urllib.parse.urlencode({
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri
        }).encode("utf-8")
        
        token_req = urllib.request.Request(token_url, data=token_data, headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(token_req) as res:
            res_data = json.loads(res.read().decode("utf-8"))
            access_token = res_data["access_token"]
            refresh_token = res_data.get("refresh_token")
            
        userinfo_url = "https://www.googleapis.com/oauth2/v3/userinfo"
        userinfo_req = urllib.request.Request(userinfo_url, headers={"Authorization": f"Bearer {access_token}"})
        with urllib.request.urlopen(userinfo_req) as res:
            user_data = json.loads(res.read().decode("utf-8"))
            email = user_data.get("email", "Пользователь Google")
            
        if refresh_token:
            cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('gdrive_refresh_token', ?)", (refresh_token,))
        cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('gdrive_email', ?)", (email,))
        conn.commit()
        conn.close()
        
        run_background_sync()
        
        return OAUTH_SUCCESS_HTML
    except Exception as e:
        if 'conn' in locals() and conn:
            conn.close()
        return f"Ошибка при обмене токенами: {str(e)}", 500

@app.route('/api/gdrive/sync', methods=['POST'])
def gdrive_sync():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    try:
        file_id = upload_report_to_gdrive()
        link = f"https://drive.google.com/file/d/{file_id}/view?usp=sharing"
        return jsonify({"success": True, "link": link})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "message": f"Ошибка синхронизации: {str(e)}"})

@app.route('/api/wishes', methods=['POST'])
def add_wish():
    data = request.json or {}
    item_name = data.get('item_name', '').strip()
    if not item_name:
        return jsonify({"success": False, "message": "Название аксессуара не может быть пустым"}), 400
        
    cashier_name = 'Кассир'
    if session.get('owner_logged_in', False):
        cashier_name = 'Владелец'
    elif session.get('cashier_name'):
        cashier_name = session.get('cashier_name')
        
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO wishes (item_name, cashier_name) VALUES (?, ?)", (item_name, cashier_name))
        conn.commit()
        conn.close()
        
        # Trigger GDrive backup report sync
        try:
            upload_report_to_gdrive()
        except Exception as e:
            print(f"Error syncing report after wish log: {e}")
            
        return jsonify({"success": True, "message": "Пожелание клиента успешно сохранено!"})
    except Exception as e:
        conn.close()
        return jsonify({"success": False, "message": f"Ошибка: {str(e)}"}), 500

@app.route('/api/wishes', methods=['GET'])
def get_wishes():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM wishes ORDER BY id DESC")
    rows = cursor.fetchall()
    conn.close()
    
    wishes_list = []
    for r in rows:
        wishes_list.append(dict(r))
    return jsonify({"success": True, "wishes": wishes_list})

@app.route('/api/wishes/<int:wish_id>', methods=['DELETE'])
def delete_wish(wish_id):
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM wishes WHERE id = ?", (wish_id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": "Пожелание решено"})
    except Exception as e:
        conn.close()
        return jsonify({"success": False, "message": f"Ошибка: {str(e)}"}), 500

@app.route('/api/app/shutdown', methods=['POST'])
def shutdown_app():
    if not session.get('owner_logged_in', False):
        return jsonify({"success": False, "message": "Доступ разрешен только владельцу"}), 403
        
    def kill_process():
        time.sleep(0.5)
        os._exit(0)
        
    Thread(target=kill_process).start()
    return jsonify({"success": True, "message": "Приложение успешно выключено. Вы можете закрыть эту вкладку."})

# --- BROWSER INITIALIZATION & SERVER START ---

def open_browser(port):
    import subprocess
    url = f'http://127.0.0.1:{port}'
    
    # Common system paths for Chromium browsers (Chrome and Edge) on Windows
    paths = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    
    launched = False
    for path in paths:
        if os.path.exists(path):
            try:
                # --app: opens in borderless window, hiding browser navigation/tabs
                # --kiosk-printing: forces window.print() to print directly to the default printer without a dialog
                subprocess.Popen([path, f"--app={url}", "--kiosk-printing", "--disable-save-password-bubble", "--disable-autofill", "--disable-features=AutofillServerCommunication,PasswordGeneration"])
                launched = True
                break
            except Exception:
                continue
                
    if not launched:
        # Fallback to standard system browser
        import webbrowser
        webbrowser.open(url)

def get_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port

def free_port_by_killing_process(port):
    import subprocess
    import os
    import time
    try:
        current_pid = os.getpid()
        # 1. Terminate any duplicate/stale easy-crm executables
        try:
            cmd_tasks = 'tasklist /FO CSV /NH'
            out_tasks = subprocess.check_output(cmd_tasks, shell=True).decode('cp866', errors='ignore')
            for line in out_tasks.splitlines():
                line_clean = line.replace('"', '').strip()
                parts = line_clean.split(',')
                if len(parts) >= 2:
                    pname = parts[0].lower()
                    pid_str = parts[1]
                    if 'easy-crm' in pname and pid_str.isdigit():
                        t_pid = int(pid_str)
                        if t_pid != current_pid:
                            subprocess.run(f'taskkill /F /PID {t_pid}', shell=True, capture_output=True)
        except Exception:
            pass

        # 2. Find PIDs listening on the specified port
        cmd = f'netstat -ano | findstr :{port}'
        output = subprocess.check_output(cmd, shell=True).decode('cp866', errors='ignore')
        pids = set()
        for line in output.splitlines():
            if 'LISTENING' in line:
                parts = line.strip().split()
                if len(parts) >= 5:
                    pid = parts[-1]
                    if pid.isdigit() and int(pid) != os.getpid():
                        pids.add(int(pid))
        
        for pid in pids:
            print(f"Port {port} is held by PID {pid}. Terminating it to release the port...")
            subprocess.run(f'taskkill /F /PID {pid}', shell=True, capture_output=True)
            
        if pids:
            time.sleep(0.5)
    except Exception as e:
        print(f"Failed to force-release port {port}: {e}")

def background_update_check():
    time.sleep(3.0)  # Wait for UI and server to be fully ready
    try:
        if check_for_updates():
            trigger_update_and_exit()
    except Exception as e:
        print(f"Background update check error: {e}")

def prewarm_all_caches():
    global _cached_setup_complete, _cached_owner_password_hash
    global _cached_cashiers, _cached_cashiers_map
    global _cached_active_shift, _cached_active_shift_ts

    # 1. Warm auth, cashiers, and active shift FIRST (super fast ~300ms)
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute("SELECT value FROM settings WHERE key = 'owner_password'")
        row = cursor.fetchone()
        if row and row[0]:
            _cached_setup_complete = True
            _cached_owner_password_hash = row[0]
        else:
            _cached_setup_complete = False
            
        cursor.execute("SELECT id, name, email, password FROM cashiers ORDER BY name ASC")
        rows = cursor.fetchall()
        c_list = []
        c_map = {}
        for r in rows:
            d = dict(r)
            c_map[int(d['id'])] = d
            c_list.append({"id": d['id'], "name": d['name'], "email": d['email']})
        _cached_cashiers = c_list
        _cached_cashiers_map = c_map
        
        cursor.execute("SELECT * FROM shifts WHERE status = 'open' LIMIT 1")
        srow = cursor.fetchone()
        _cached_active_shift = dict(srow) if srow else None
        _cached_active_shift_ts = time.time()
        
        conn.close()
        print("Pre-warmed in-memory RAM caches (auth, cashiers, active shift) successfully.")
    except Exception as e:
        print(f"Prewarm quick caches error: {e}")

    # 2. Warm catalog in background
    try:
        get_or_load_catalog()
        print("Pre-warmed catalog cache successfully.")
    except Exception as e:
        print(f"Prewarm catalog error: {e}")

if __name__ == '__main__':
    try:
        port = 5000
        # Test if port 5000 is available
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(('127.0.0.1', port))
            s.close()
        except OSError:
            # Try to force-release the port
            free_port_by_killing_process(port)
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.bind(('127.0.0.1', port))
                s.close()
            except OSError:
                try:
                    show_windows_messagebox(
                        "Ошибка запуска CRM", 
                        "Порт 5000 уже занят другой запущенной копией CRM или иной программой.\n\n"
                        "Пожалуйста, выключите другие копии CRM через меню 'Настройки' -> 'Выключить CRM систему' и попробуйте снова.",
                        is_error=True
                    )
                except Exception:
                    print("ERROR: Port 5000 is already in use by another process.", file=sys.stderr)
                sys.exit(1)
            
        print(f"==================================================")
        print(f" CRM system starting on: http://127.0.0.1:{port}")
        print(f" Database: VPS PostgreSQL (89.124.92.53:5432)")
        print(f" To stop the application, close this window.")
        print(f"==================================================")
        
        # Open browser immediately (0.4s)
        Timer(0.4, lambda: open_browser(port)).start()
        
        # Pre-warm all memory caches in background for instant 0ms responses
        Thread(target=prewarm_all_caches, daemon=True).start()
        
        # Check updates non-blockingly in background
        Thread(target=background_update_check, daemon=True).start()
        
        # Auto-close shifts past midnight in background
        Thread(target=auto_close_shifts_loop, daemon=True).start()
        
        # Start background Google Drive sync thread
        sync_thread = Thread(target=gdrive_sync_loop, daemon=True)
        sync_thread.start()
        
        # Fallback FTP sync only if PostgreSQL is not active
        if psycopg2 is None:
            ftp_sync_thread = Thread(target=ftp_sync_loop, daemon=True)
            ftp_sync_thread.start()
        
        app.run(host='0.0.0.0', port=port, debug=False)
    except Exception as e:
        import traceback
        err_log = os.path.join(app_data_dir, 'startup_error.log')
        with open(err_log, 'w', encoding='utf-8') as f:
            traceback.print_exc(file=f)
        try:
            show_windows_messagebox("Ошибка запуска", f"Произошла ошибка при запуске:\n{str(e)}\n\nПодробности записаны в {err_log}", is_error=True)
        except Exception:
            pass
        sys.exit(1)

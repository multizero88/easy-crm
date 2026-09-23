import subprocess
import sys
import os
import shutil
import re
from ftplib import FTP

def main():
    print("Starting CRM compilation and release process...")
    
    # Calculate paths relative to build.py location
    project_dir = os.path.dirname(os.path.abspath(__file__))
    venv_dir = os.path.abspath(os.path.join(project_dir, '..', 'venv'))
    pyinstaller_bin = os.path.join(venv_dir, 'Scripts', 'pyinstaller.exe')
    
    if not os.path.exists(pyinstaller_bin):
        # Fallback to system command search
        pyinstaller_bin = 'pyinstaller'
        
    # 1. Handle Version Incrementing
    version_file = os.path.join(project_dir, 'version.txt')
    if os.path.exists(version_file):
        try:
            with open(version_file, 'r', encoding='utf-8') as vf:
                curr_version = vf.read().strip()
        except Exception:
            curr_version = "1.15"
    else:
        curr_version = "1.15"
        
    try:
        new_version = f"{float(curr_version) + 0.01:.2f}"
    except (ValueError, TypeError):
        new_version = "1.16"
        
    try:
        with open(version_file, 'w', encoding='utf-8') as vf:
            vf.write(new_version)
        print(f"Incremented version: {curr_version} -> {new_version}")
    except Exception as e:
        print(f"Failed to write version.txt: {e}")
        new_version = curr_version
        
    # 2. Inject version into app.py
    app_file = os.path.join(project_dir, 'app.py')
    if os.path.exists(app_file):
        try:
            with open(app_file, 'r', encoding='utf-8') as af:
                app_code = af.read()
            
            # Replace APP_VERSION = "..."
            app_code = re.sub(r'APP_VERSION = "[^"]+"', f'APP_VERSION = "{new_version}"', app_code)
            
            with open(app_file, 'w', encoding='utf-8') as af:
                af.write(app_code)
            print(f"Injected APP_VERSION = \"{new_version}\" into app.py")
        except Exception as e:
            print(f"Failed to inject version into app.py: {e}")
            
    cmd = [
        pyinstaller_bin,
        '--onefile',
        '--noconsole',
        '--collect-all', 'reportlab',
        '--collect-all', 'psycopg2',
        '--hidden-import', 'psycopg2',
        '--hidden-import', 'psycopg2.extras',
        '--add-data', 'templates;templates',
        '--add-data', 'static;static',
        '--name', 'easy-crm',
        'app.py'
    ]
    
    print(f"Executing: {' '.join(cmd)}")
    
    # Run PyInstaller
    result = subprocess.run(cmd, cwd=project_dir, shell=True)
    
    if result.returncode == 0:
        print("\n==================================================")
        print(" COMPILATION COMPLETED SUCCESSFULLY!")
        print(" The standalone executable is saved in:")
        print(f" {os.path.join(project_dir, 'dist', 'easy-crm.exe')}")
        print("==================================================")
        try:
            shutil.copy2(os.path.join(project_dir, 'dist', 'easy-crm.exe'), os.path.join(project_dir, 'easy-crm.exe'))
            print(" Copied easy-crm.exe to project root.")
        except Exception as e:
            print(f" Warning: could not copy to root: {e}")
        
        # 3. Upload compiled release and version text to FTP server
        try:
            print("\nConnecting to FTP server to upload new release...")
            ftp = FTP()
            ftp.connect("178.218.207.135", 21, timeout=15)
            ftp.login("user1309", "649260254b")
            
            # Upload version.txt
            print("Uploading version.txt to FTP...")
            with open(version_file, "rb") as vf:
                ftp.storbinary("STOR version.txt", vf)
                
            # Upload easy-crm.exe
            exe_path = os.path.join(project_dir, 'dist', 'easy-crm.exe')
            print(f"Uploading {exe_path} to FTP as easy-crm.exe...")
            with open(exe_path, "rb") as ef:
                ftp.storbinary("STOR easy-crm.exe", ef)
                
            ftp.quit()
            print("Publish to FTP completed successfully!")
        except Exception as ftp_err:
            print(f"\n[ERROR] Failed to upload files to FTP: {ftp_err}")

        # 4. Sync release and version text to VPS Web Server (89.124.92.53)
        try:
            print("\nConnecting to VPS (89.124.92.53) via SSH to update web release...")
            import paramiko
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            ssh.connect("89.124.92.53", username="root", password="5iVTCC,1T1NFV7iv5i5x", timeout=15)
            
            vps_cmd = '''
curl -s -u user1309:649260254b ftp://178.218.207.135/easy-crm.exe -o /var/www/easy-crm/updates/easy-crm.exe &&
cp /var/www/easy-crm/updates/easy-crm.exe /var/www/easy-crm/easy-crm.exe &&
curl -s -u user1309:649260254b ftp://178.218.207.135/version.txt -o /var/www/easy-crm/updates/version.txt &&
cp /var/www/easy-crm/updates/version.txt /var/www/easy-crm/version.txt &&
chown -R www-data:www-data /var/www/easy-crm &&
chmod -R 755 /var/www/easy-crm
'''
            stdin, stdout, stderr = ssh.exec_command(vps_cmd)
            stdout.channel.recv_exit_status()
            ssh.close()
            print("Publish to VPS (89.124.92.53) completed successfully!")
        except Exception as vps_err:
            print(f"\n[ERROR] Failed to sync files to VPS: {vps_err}")
        
        # Cleanup temporary files (keep dist directory and compiled binary)
        print("\nCleaning up temporary build artifacts...")
        spec_file = os.path.join(project_dir, 'easy-crm.spec')
        build_folder = os.path.join(project_dir, 'build')
        
        if os.path.exists(spec_file):
            try:
                os.remove(spec_file)
                print(" Removed easy-crm.spec")
            except Exception as e:
                print(f" Failed to remove spec file: {e}")
                
        if os.path.exists(build_folder):
            try:
                shutil.rmtree(build_folder)
                print(" Removed build/ directory")
            except Exception as e:
                print(f" Failed to remove build directory: {e}")
                
        print("Cleanup completed.")
    else:
        print(f"\n[ERROR] PyInstaller failed with exit code: {result.returncode}")
        sys.exit(result.returncode)

if __name__ == '__main__':
    main()

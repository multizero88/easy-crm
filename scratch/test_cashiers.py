import re
import os
import sys
import json
import urllib.request
import urllib.parse
from urllib.error import HTTPError

port = 5000
base_url = f"http://127.0.0.1:{port}"
print(f"Testing on port: {port}")

# Set up urllib CookieJar to handle session
from urllib.request import HTTPCookieProcessor
from http.cookiejar import CookieJar
cj = CookieJar()
opener = urllib.request.build_opener(HTTPCookieProcessor(cj))

def make_request(url, data=None, headers=None, ignore_errors=False, method=None):
    if headers is None:
        headers = {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with opener.open(req) as res:
            return res.status, res.read().decode("utf-8")
    except HTTPError as e:
        if ignore_errors:
            try:
                return e.code, e.read().decode("utf-8")
            except Exception:
                return e.code, ""
        print(f"HTTPError on {url}: status={e.code}")
        try:
            print("Response body:", e.read().decode("utf-8"))
        except Exception:
            pass
        raise e

# 1. Login as owner
login_url = f"{base_url}/api/auth/login"
login_data = json.dumps({"password": "1234"}).encode("utf-8")
status, body = make_request(login_url, data=login_data, headers={"Content-Type": "application/json"})
print("Owner Login Response:", body)

# 2. Get settings to ensure it works
settings_url = f"{base_url}/api/gdrive/settings"
status, body = make_request(settings_url)
print("Get Settings:", body)

# 3. Change owner password (verify validation error)
change_pw_url = f"{base_url}/api/auth/change_owner_password"
pw_data = json.dumps({
    "old_password": "wrong_password",
    "new_password": "4321",
    "confirm_password": "4321"
}).encode("utf-8")
status, body = make_request(change_pw_url, data=pw_data, headers={"Content-Type": "application/json"}, ignore_errors=True)
print("Change Password (Wrong old PW) Response:", status, body)
assert status == 400

# 4. Change owner password successfully
pw_data = json.dumps({
    "old_password": "1234",
    "new_password": "4321",
    "confirm_password": "4321"
}).encode("utf-8")
status, body = make_request(change_pw_url, data=pw_data, headers={"Content-Type": "application/json"})
print("Change Password (Success) Response:", body)

# 5. Verify old password doesn't work anymore
login_data = json.dumps({"password": "1234"}).encode("utf-8")
status, body = make_request(login_url, data=login_data, headers={"Content-Type": "application/json"}, ignore_errors=True)
print("Login with old password response:", status, body)
assert status == 401

# 6. Verify new password works
login_data = json.dumps({"password": "4321"}).encode("utf-8")
status, body = make_request(login_url, data=login_data, headers={"Content-Type": "application/json"})
print("Login with new password response:", body)

# 7. Get Cashiers (should contain seeded Alisa)
cashiers_url = f"{base_url}/api/cashiers"
status, body = make_request(cashiers_url)
cashiers = json.loads(body)
print("Get Cashiers Response:", cashiers)
assert len(cashiers) >= 1
alisa = next(c for c in cashiers if c["email"] == "Alisashadmanova@gmail.com")
assert alisa["name"] == "Алиса"

# 8. Add new cashier
add_cashier_data = json.dumps({
    "name": "Иван",
    "email": "ivan@example.com",
    "password": "5555"
}).encode("utf-8")
status, body = make_request(cashiers_url, data=add_cashier_data, headers={"Content-Type": "application/json"})
print("Add Cashier Response:", body)

# 9. Get Cashiers again
status, body = make_request(cashiers_url)
cashiers = json.loads(body)
print("Get Cashiers after adding Response:", cashiers)
assert len(cashiers) >= 2
ivan = next(c for c in cashiers if c["email"] == "ivan@example.com")
assert ivan["name"] == "Иван"

# 10. Cashier Login (Ivan)
cashier_login_url = f"{base_url}/api/auth/cashier_login"
cashier_login_data = json.dumps({
    "cashier_id": ivan["id"],
    "password": "5555"
}).encode("utf-8")
status, body = make_request(cashier_login_url, data=cashier_login_data, headers={"Content-Type": "application/json"})
print("Cashier Login (Ivan) Response:", body)

# 11. Delete Cashier (Ivan)
delete_url = f"{base_url}/api/cashiers/{ivan['id']}"
status, body = make_request(delete_url, method="DELETE")
print("Delete Cashier Response:", body)

# 12. Verify Cashier is deleted
status, body = make_request(cashiers_url)
cashiers = json.loads(body)
assert not any(c["id"] == ivan["id"] for c in cashiers)
print("Verified Cashier deletion!")

# Reset owner password to 1234 for consistency
pw_data = json.dumps({
    "old_password": "4321",
    "new_password": "1234",
    "confirm_password": "1234"
}).encode("utf-8")
status, body = make_request(change_pw_url, data=pw_data, headers={"Content-Type": "application/json"})
print("Reset Owner Password successfully.")

print("\n--- ALL CASHIER AND PASSWORD TESTS PASSED SUCCESSFULLY ---")

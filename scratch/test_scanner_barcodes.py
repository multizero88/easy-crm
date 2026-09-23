import os
import sys
import json
import urllib.request
import urllib.parse
from urllib.error import HTTPError

port = 5000
base_url = f"http://127.0.0.1:{port}"
print(f"Testing Barcode Scanner Integrations on port: {port}")

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

# 2. Add product with a custom barcode
add_prd_url = f"{base_url}/api/products"
prd_data = json.dumps({
    "barcode": "99991,99992",
    "type": "Наушники",
    "brand": "Apple",
    "model": "AirPods 3",
    "price": 2500000,
    "cost_price": 2000000,
    "stock": 10,
    "supplier": "ООО Дистрибьютор"
}).encode("utf-8")
status, body = make_request(add_prd_url, data=prd_data, headers={"Content-Type": "application/json"})
product = json.loads(body)["product"]
print("Added Product with custom barcodes:", product)
assert "99991,99992" in product["barcode"]

# 3. Try to add another product with a duplicate barcode (99992)
duplicate_prd_data = json.dumps({
    "barcode": "99992,8888",
    "type": "Наушники",
    "brand": "Apple",
    "model": "AirPods Pro 2",
    "price": 3500000,
    "cost_price": 2800000,
    "stock": 5,
    "supplier": "ООО Дистрибьютор"
}).encode("utf-8")
status, body = make_request(add_prd_url, data=duplicate_prd_data, headers={"Content-Type": "application/json"}, ignore_errors=True)
print("Duplicate response status:", status, "body:", body)
assert status == 400
resp_data = json.loads(body)
assert resp_data["is_duplicate"] is True
assert resp_data["product_id"] == product["id"]

# 4. Lookup by barcode 1 (99991)
lookup_url1 = f"{base_url}/api/products/99991"
status, body = make_request(lookup_url1)
p1 = json.loads(body)["product"]
print("Lookup by 99991 Response product:", p1["name"])
assert p1["id"] == product["id"]

# 5. Lookup by barcode 2 (99992)
lookup_url2 = f"{base_url}/api/products/99992"
status, body = make_request(lookup_url2)
p2 = json.loads(body)["product"]
print("Lookup by 99992 Response product:", p2["name"])
assert p2["id"] == product["id"]

# 6. Cleanup - delete test product
delete_prd_url = f"{base_url}/api/products/{product['id']}"
status, body = make_request(delete_prd_url, method="DELETE")
print("Deleted test product!")

print("\n--- ALL SCANNER BARCODE TESTS PASSED SUCCESSFULLY ---")

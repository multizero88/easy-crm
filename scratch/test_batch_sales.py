import os
import sys
import json
import urllib.request
import urllib.parse
from urllib.error import HTTPError

port = 5000
base_url = f"http://127.0.0.1:{port}"
print(f"Testing Batch Sales on port: {port}")

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
print("Login Response:", body)

# 2. Add two test products
add_prd_url = f"{base_url}/api/products"
p1_data = json.dumps({
    "barcode": "66661",
    "type": "Кабель",
    "brand": "Baseus",
    "model": "Type-C 100W",
    "price": 100000,
    "cost_price": 50000,
    "stock": 10,
    "supplier": "Baseus Distributor"
}).encode("utf-8")
status, body1 = make_request(add_prd_url, data=p1_data, headers={"Content-Type": "application/json"})
p1 = json.loads(body1)["product"]

p2_data = json.dumps({
    "barcode": "66662",
    "type": "Чехол",
    "brand": "Apple",
    "model": "Silicone Case",
    "price": 200000,
    "cost_price": 80000,
    "stock": 5,
    "supplier": "Apple Distributor"
}).encode("utf-8")
status, body2 = make_request(add_prd_url, data=p2_data, headers={"Content-Type": "application/json"})
p2 = json.loads(body2)["product"]
print("Created test products!")

# 3. Open shift (necessary to register sales)
# Let's check active shift first
shift_status_url = f"{base_url}/api/shift/active"
status, shift_body = make_request(shift_status_url)
shift_data = json.loads(shift_body)

if not shift_data.get("shift"):
    print("Opening a new cashier shift...")
    open_shift_url = f"{base_url}/api/shift/open"
    open_data = json.dumps({"cash_start": 500000}).encode("utf-8")
    status, open_body = make_request(open_shift_url, data=open_data, headers={"Content-Type": "application/json"})
    print("Shift opened:", open_body)

# 4. Perform a batch checkout:
# Cable: 2 units with 10% discount
# Case: 1 unit with 0% discount
sales_url = f"{base_url}/api/sales"
checkout_data = json.dumps({
    "payment_method": "cash",
    "items": [
        { "barcode": "66661", "quantity": 2, "discount_percent": 28.0 },
        { "barcode": "66662", "quantity": 1, "discount_percent": 0.0 }
    ]
}).encode("utf-8")

status, sales_resp = make_request(sales_url, data=checkout_data, headers={"Content-Type": "application/json"})
print("Batch Checkout Response:", sales_resp)
resp_json = json.loads(sales_resp)
assert resp_json["success"] is True
assert len(resp_json["sales"]) == 2

# Verify cable price calculation: 100,000 * 0.72 = 72,000 final price
cable_sale = next(s for s in resp_json["sales"] if s["product_name"] == "Кабель Baseus Type-C 100W")
assert cable_sale["price_final"] == 72000
assert cable_sale["quantity"] == 2

# Verify case price calculation: 200,000 final price
case_sale = next(s for s in resp_json["sales"] if s["product_name"] == "Чехол Apple Silicone Case")
assert case_sale["price_final"] == 200000
assert case_sale["quantity"] == 1

# 5. Verify product stock level deductions
status, cable_verify_body = make_request(f"{base_url}/api/products/66661")
cable_stock = json.loads(cable_verify_body)["product"]["stock"]
print("Cable remaining stock (expected 8):", cable_stock)
assert cable_stock == 8

status, case_verify_body = make_request(f"{base_url}/api/products/66662")
case_stock = json.loads(case_verify_body)["product"]["stock"]
print("Case remaining stock (expected 4):", case_stock)
assert case_stock == 4

# 6. Cleanup test products
make_request(f"{base_url}/api/products/{p1['id']}", method="DELETE")
make_request(f"{base_url}/api/products/{p2['id']}", method="DELETE")
print("Cleaned up test products.")

print("\n--- ALL BATCH SALES CHECKOUT TESTS PASSED SUCCESSFULLY ---")

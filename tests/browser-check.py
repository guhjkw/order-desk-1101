"""Playwright check of the real page, served over http (fetches data/sample.json) and opened off disk (embedded data).
Run: python3 tests/browser-check.py    (after python3 build.py)"""
import pathlib
import re
import socket
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tests" / "screenshots"
SHOTS.mkdir(exist_ok=True)
passed = failed = 0


def ok(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("PASS " + name)
    else:
        failed += 1
        print("FAIL " + name + ("  -> " + str(detail)[:400] if detail != "" else ""))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


port = free_port()
server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"], cwd=str(ROOT),
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
base = "http://127.0.0.1:%d/" % port
for _ in range(50):
    try:
        urllib.request.urlopen(base, timeout=1)
        break
    except Exception:
        time.sleep(0.1)

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        requests = []
        page.on("request", lambda r: requests.append(r.url))
        page.goto(base + "index.html")
        page.wait_for_selector("body[data-ready='1']")

        def kpis():
            return [v.strip() for v in page.locator("#kpis .kpi .v").all_inner_texts()]

        def status():
            return page.inner_text("#d-status").strip()

        def pick(doc_id):
            page.click("#list [data-pick='%s']" % doc_id)

        def fix(code, label_part):
            page.locator(".issue[data-code='%s'] button" % code, has_text=label_part).first.click()

        def close_drawer():
            page.click("[data-act='drawer-close']")

        print("1. Inbox")
        ok("1.1 loads the engine and the sample data over http", any(u.endswith("src/orderEngine.js") for u in requests) and any(u.endswith("data/sample.json") for u in requests))
        k = kpis()
        ok("1.2 Brandt inbox: 7 received, 2 ready, 1 to review, 4 blocked, 0 sent", k[:5] == ["7", "2", "1", "4", "0"], k)
        ok("1.3 first order opens: M-1041 from Meier is ready, 3 lines, net 322,53 €",
           status() == "Ready" and "Meier Metallbau GmbH" in page.inner_text("#detail") and page.locator("#detail tr.ln").count() == 3 and "322,53 €" in page.inner_text("#detail tfoot"))
        page.locator("#detail tr.ln").first.click()
        hl = page.locator("#doc .hl").all_inner_texts()
        ok("1.4 clicking line 1 highlights where it was read in the e-mail", len(hl) == 1 and "20 KAR 100-820" in hl[0], hl)

        print("2. Approve and Business Central")
        page.click("#detail [data-act='approve']")
        drawer = page.inner_text("#drawer")
        ok("2.1 approve shows the real requests: sign-in, lookup by order number, header, 3 lines",
           page.locator("#drawer .req").count() == 6 and "externalDocumentNumber eq '4500012345'" in drawer and "SO-104818" in drawer, drawer[:300])
        page.screenshot(path=str(SHOTS / "2-business-central-drawer.png"))
        close_drawer()
        ok("2.2 the order is now Sent and the sent counter is 1", status() == "Sent" and kpis()[4] == "1", kpis())

        print("3. Fixing a blocked order")
        pick("M-1044")
        ok("3.1 M-1044 is blocked by an unknown article", status() == "Blocked" and page.locator(".issue[data-code='UNKNOWN_ITEM']").count() == 1)
        first_fix = page.locator(".issue[data-code='UNKNOWN_ITEM'] button").first.inner_text()
        ok("3.2 the first suggestion is 100-820 because two characters are swapped", "100-820" in first_fix and "swapped" in first_fix, first_fix)
        page.locator("#detail tr.ln").first.click()
        marks = page.locator("#doc mark").all_inner_texts()
        ok("3.3 the typo is marked in the original e-mail", "100-280" in marks, marks)
        page.screenshot(path=str(SHOTS / "1-inbox-m1044.png"))
        fix("UNKNOWN_ITEM", "100-820")
        ok("3.4 choosing the suggestion changes Blocked to Needs review", status() == "Needs review", status())
        fix("DESC_MATCH", "200-008")
        fix("DESC_MATCH", "520-006")
        ok("3.5 confirming the two description matches makes it Ready", status() == "Ready", status())
        page.click("#detail [data-act='approve']")
        ok("3.6 approving creates the next sales order, SO-104819", "SO-104819" in page.inner_text("#drawer"))
        close_drawer()

        print("4. Duplicates and never twice")
        pick("M-1045")
        ok("4.1 the forwarded copy is blocked as a duplicate of M-1041", status() == "Blocked" and "Duplicate of M-1041" in page.inner_text("#detail"))
        fix("DUPLICATE", "Not a duplicate")
        ok("4.2 releasing it makes it Ready", status() == "Ready", status())
        page.click("#detail [data-act='approve']")
        drawer = page.inner_text("#drawer")
        ok("4.3 Business Central lookup finds SO-104818 and creates nothing", "Already in Business Central as SO-104818" in drawer and page.locator("#drawer .resp.skipped").count() == 4, drawer[:300])
        close_drawer()

        print("5. Rückfrage and editing fields")
        pick("M-1043")
        page.locator("#detail tr.ln").nth(1).click()
        ok("5.1 Excel order: line 2 highlights its row in the sheet", page.locator("#doc .sheet tr.hl").count() == 1 and "720-300" in page.inner_text("#doc .sheet tr.hl"))
        page.screenshot(path=str(SHOTS / "3-inbox-m1043-excel.png"))
        page.click("#detail [data-act='ask']")
        subj = page.input_value("#m-subj")
        body = page.input_value("#m-body")
        ok("5.2 the German Rückfrage asks about the discontinued item, the minimum and the date",
           subj == "Rückfrage zu Ihrer Bestellung HT-2026-118" and "ausgelaufen" in body and "Mindestabnahme" in body and "Liefertermin" in body, subj)
        page.click("[data-act='mark-asked']")
        ok("5.3 marking it as asked shows on the inbox list", "Asked" in page.inner_text("#list [data-pick='M-1043']"))
        date_in = page.locator("#detail input[data-ch='date']")
        date_in.fill("morgen")
        date_in.dispatch_event("change")
        ok("5.4 a delivery date that is not a date is refused with a reason", "invalid" in (date_in.get_attribute("class") or "") and "not a date" in page.inner_text("#toast"))
        date_in.fill("KW 47")
        date_in.dispatch_event("change")
        ok("5.5 typing KW 47 sets Monday 16.11.2026 and clears the missing-date warning",
           page.input_value("#detail input[data-ch='date']") == "16.11.2026" and page.locator(".issue[data-code='NO_DATE']").count() == 0)

        print("6. Rules")
        page.click("nav [data-go='rules']")
        page.fill("#r-tol", "10")
        eff = page.inner_text("#r-effect")
        ok("6.1 raising the price tolerance to 10% removes M-1042's price warning at once", "M-1042" in eff and "price check" in eff, eff)
        page.fill("#r-tol", "80")
        ok("6.2 an 80% tolerance is refused with a reason", "Not applied" in page.inner_text("#r-err") and "0 and 50" in page.inner_text("#r-err"))
        page.fill("#r-tol", "2")
        page.select_option("#r-state", "SN")
        ok("6.3 switching to Saxony lists Buß- und Bettag on 18.11.2026", "Buß- und Bettag" in page.inner_text("#hol") and "18.11.2026" in page.inner_text("#hol"))
        page.select_option("#r-state", "NW")

        print("7. Paste your own order")
        page.click("nav [data-go='inbox']")
        page.click("[data-act='paste-open']")
        page.click("[data-act='paste-submit']")
        ok("7.1 an empty order is refused with a reason", "Paste the order text" in page.inner_text("#p-errors"))
        page.fill("#p-from", "not an address")
        page.fill("#p-body", "10 Stk 100-820")
        page.click("[data-act='paste-submit']")
        ok("7.2 a sender without an e-mail address is refused", "must contain an e-mail address" in page.inner_text("#p-errors"))
        page.click("[data-act='paste-example']")
        page.click("[data-act='paste-submit']")
        ok("7.3 the pasted Kruse order is read: 4 lines, blocked because pallets are not a unit of 410-650",
           "P-1" in page.inner_text("#list") and status() == "Blocked" and page.locator("#detail tr.ln").count() == 4 and "PAL is not a sales unit of 410-650" in page.inner_text("#detail"))

        print("8. Add a company")
        page.click("nav [data-go='setup']")
        page.click("[data-act='su-example']")
        ok("8.1 example product list: 9 ready, 2 rows skipped with reasons", page.inner_text("#su-prod-n").strip() == "9 products ready, 2 rows skipped" and "auf Anfrage" in page.inner_text("#su-prod-out"))
        ok("8.2 example customers: 4 ready, 1 skipped, 2 values dropped", page.inner_text("#su-cust-n").strip() == "4 customers ready, 1 row skipped, 2 values dropped", page.inner_text("#su-cust-n"))
        page.select_option("#su-prod-out select[data-f='price']", "4")
        ok("8.3 choosing the EK-Preis column changes the imported price to 0,52 €", "0,52 €" in page.inner_text("#su-prod-out table"))
        page.select_option("#su-prod-out select[data-f='price']", "3")
        page.screenshot(path=str(SHOTS / "4-add-company.png"))
        page.fill("#su-name", "")
        page.fill("#su-bct", "1234")
        page.click("[data-act='su-create']")
        errs = page.inner_text("#su-errors")
        ok("8.4 a missing name and a malformed tenant ID are refused with reasons", "Company name is missing" in errs and "GUID" in errs, errs)
        page.fill("#su-name", "Nordlicht Elektrogroßhandel GmbH")
        page.fill("#su-bct", "4d2c8e1a-7b39-4f05-a6d2-0c9e5b7f13a8")
        page.click("[data-act='su-create']")
        opts = page.locator("#tenant option").all_inner_texts()
        ok("8.5 the company is created and selected, with an empty inbox", len(opts) == 3 and page.input_value("#tenant") == "nordlicht-elektrogrosshandel" and page.locator("#kpis .kpi .v").first.inner_text() == "0", opts)
        page.click("[data-act='paste-open']")
        page.click("[data-act='paste-example']")
        page.click("[data-act='paste-submit']")
        ok("8.6 its first order: customer found from its own list, metres read, Ready", status() == "Ready" and "Elektro Schröder GmbH" in page.inner_text("#detail") and "50 M" in page.locator("#detail tr.ln").first.inner_text(), page.inner_text("#detail")[:300])
        page.click("#detail [data-act='approve']")
        ok("8.7 it sends to its own Business Central numbering (SO-100001)", "SO-100001" in page.inner_text("#drawer"))
        close_drawer()

        print("9. Second company, master data, Business Central page")
        page.select_option("#tenant", "hofmann")
        ok("9.1 Hofmann has its own 3 orders", page.locator("#list li[data-pick]").count() == 3 and kpis()[0] == "3")
        pick("H-201")
        ok("9.2 H-201: EAN codes read, cheese matched by description for review", status() == "Needs review" and "by description, please confirm" in page.inner_text("#detail"))
        page.select_option("#tenant", "brandt")
        page.click("nav [data-go='products']")
        page.fill("#prod-q", "M10")
        ok("9.3 product search narrows 13 products to the 2 in M10", page.inner_text("#prod-n").strip() == "2 of 13 products", page.inner_text("#prod-n"))
        page.click("nav [data-go='bc']")
        bc = page.inner_text("#bc-orders")
        ok("9.4 Business Central page lists SO-104817 (earlier), SO-104818 and SO-104819, nothing twice",
           page.locator("#bc-orders tbody tr").count() == 3 and all(n in bc for n in ["SO-104817", "SO-104818", "SO-104819"]), bc)

        print("10. Running costs and proposal")
        page.click("nav [data-go='costs']")
        ok("10.1 default running cost: $127.10 a month, $25.42 per company", page.inner_text("#c-total") == "$127.10" and page.inner_text("#c-per") == "$25.42")
        page.fill("#c-orders", "10000")
        ok("10.2 10,000 orders a month: $135.50", page.inner_text("#c-total") == "$135.50", page.inner_text("#c-total"))
        page.fill("#c-orders", "0")
        ok("10.3 zero orders is refused with a reason", "Orders per month must be a whole number" in page.inner_text("#c-err"))
        page.fill("#c-orders", "2000")
        page.click("nav [data-go='proposal']")
        prop = page.inner_text("#v-proposal")
        ok("10.4 proposal answers with the engine's numbers: MVP $6,300, full $13,860, tests 65 passed",
           "$6,300" in prop and "$13,860" in prop and "65 node checks passed, 0 failed" in prop, prop[:200])
        ok("10.5 eight milestones, each with a done-when line", page.locator("#v-proposal table.grid tbody tr").count() == 10)
        page.set_viewport_size({"width": 1440, "height": 3600})
        page.screenshot(path=str(SHOTS / "5-proposal.png"))
        page.set_viewport_size({"width": 1440, "height": 900})

        print("11. Reset, phone width, console")
        page.click("[data-act='reset-demo']")
        page.click("nav [data-go='inbox']")
        ok("11.1 Reset demo restores 7 orders, 0 sent and two companies", kpis()[:5] == ["7", "2", "1", "4", "0"] and page.locator("#tenant option").count() == 2)
        pick("M-1042")
        page.locator("#detail tr[data-hl]").nth(3).click()
        ok("11.2 PDF order: the delivery date row highlights 25.12.2026 on the PDF page", "25.12.2026" in " ".join(page.locator("#doc .paper mark").all_inner_texts()))
        page.screenshot(path=str(SHOTS / "6-inbox-m1042-pdf.png"))
        mob = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True)
        mob.on("pageerror", lambda e: errors.append(str(e)))
        mob.goto(base + "index.html")
        mob.wait_for_selector("body[data-ready='1']")
        over = mob.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        mob.screenshot(path=str(SHOTS / "7-phone-inbox.png"))
        mob.click("nav [data-go='proposal']")
        over2 = mob.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        ok("11.3 at phone width nothing scrolls sideways (inbox and proposal)", over <= 0 and over2 <= 0, (over, over2))
        mob.close()
        ok("11.4 no console or page errors", not errors, errors)

        print("12. Opened off disk")
        disk = browser.new_page(viewport={"width": 1440, "height": 900})
        disk_err = []
        disk.on("pageerror", lambda e: disk_err.append(str(e)))
        disk.goto((ROOT / "index.html").as_uri())
        disk.wait_for_selector("body[data-ready='1']")
        ok("12.1 file:// uses the embedded data: 7 orders, no errors", disk.locator("#kpis .kpi .v").first.inner_text() == "7" and not disk_err, disk_err)
        browser.close()
finally:
    server.terminate()

print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)

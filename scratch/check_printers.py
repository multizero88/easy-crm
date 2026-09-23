import win32print

try:
    default_printer = win32print.GetDefaultPrinter()
    print(f"Default Printer: {default_printer}")
    
    hprinter = win32print.OpenPrinter(default_printer)
    try:
        info = win32print.GetPrinter(hprinter, 2)
        print(f"Printer Status: {info['Status']}")
        print(f"Jobs Count: {info['cJobs']}")
        
        if info['cJobs'] > 0:
            jobs = win32print.EnumJobs(hprinter, 0, info['cJobs'], 1)
            print("\nActive Jobs in Queue:")
            for j in jobs:
                print(f"- Job ID: {j['JobId']}, Document: {j['pDocument']}, Status: {j['Status']}, Pages: {j['TotalPages']}")
        else:
            print("No jobs in queue.")
    finally:
        win32print.ClosePrinter(hprinter)
except Exception as e:
    import traceback
    traceback.print_exc()

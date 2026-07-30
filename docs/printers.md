# Printer setup

FloCafe prints receipts and kitchen order tickets from the desktop app. Configure printers in **Settings → Printers**, then use **Test Print** before service.

## Connection types

| Type | Use it for | What you need |
| --- | --- | --- |
| Network | Receipt or kitchen printers on the local network | Printer IP address and port; most ESC/POS printers use port `9100` |
| USB | A printer connected to the FloCafe computer | A supported local USB printer and, where needed, its device path |
| WebUSB | A browser-connected printer | A compatible browser and a user-selected device; the browser sends the print bytes |

Set the paper width to match the printer: 58 mm or 80 mm. The first configured printer becomes the default; choose another default in Settings when a different printer should receive ordinary receipts.

## Kitchen printing

FloCafe can print kitchen order tickets to the default printer or route items to configured kitchen stations. A station needs an active printer and the product categories it handles. Items without a matching station fall back to the default kitchen route.

KOT printing can be disabled for the business. When it is disabled, neither automatic nor manual KOT print requests are sent.

## Troubleshooting

For a network printer, confirm that FloCafe's computer can reach the printer address and that the configured port is correct. For USB, reconnect the cable, verify the system can see the printer, and check the configured device path. Test from Settings after every change.

WebUSB printers are connected from the POS toolbar in a supported browser. Their saved entry retains print preferences, but the browser controls access to the physical device.

Do not expose FloCafe's local API to the public internet. Network printers should be reachable only from the business network.

## API

The printer endpoints are documented in [API.md](API.md#printers). They cover configured printers, detection, supported profiles, test printing, receipt printing, and kitchen tickets.

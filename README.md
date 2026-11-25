# Tab Agent

Organize your Chrome tabs by just saying what you want.

Type something like "group my GitHub tabs" or "close duplicates", and Tab Agent does it for you. Simple commands run instantly on your machine. Smarter ones, like grouping by topic, use Groq's free AI API.

## What it can do

- Group tabs by site or by topic
- Close duplicate tabs
- Ungroup or close tabs in bulk
- Add tabs to groups you already have

## Install

1. Get a free API key at [console.groq.com](https://console.groq.com)
2. Open `chrome://extensions` and turn on **Developer mode**
3. Click **Load unpacked** and choose the `chrome-manager-frontend` folder
4. Click the extension icon, then **API Key**, and paste your key

## Use it

Click the extension icon to open the side panel, type a command, and press Enter.

You can also use the address bar: type `tab`, a space, and your command, like `tab group github`.

Try:

```
group github
group by topic
close duplicates
ungroup all
```

## For developers

See [docs/DESIGN.md](docs/DESIGN.md) for how it works.

## License

MIT

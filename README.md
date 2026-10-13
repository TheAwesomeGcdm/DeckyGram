# DeckyGram
A Telegram client for Deckyloader!

**_This place is not a place of honor... no highly esteemed deed is commemorated here... nothing valued is here._**

This was written with a lot of help from AI so I would stop missing so many messages and to be able to send funny game screenshots to my family and friends.

This is _heavily_ inspired by https://github.com/Necrosiak/Steamcord 

- **Chats in the QAM**: you can also edit which chats are pinned or not. It refreshes like a regular telegram client.
- **Full chat window**: open any conversation full-screen, or open the a window from the notification tab.
- **Messages**: Photos, videos, stickers, and stickers work.
- **Message options**: Select a message to reply, react, edit your own message or delete it.
- **Send pictures**: Easily share screenshots taken from the deck.
- **Steam notifications**: Messages show up as regular steam messages, with a notification toggle in the main contact lists, and a cooldown feature in settings. Cooldown makes it where if you're being spammed with a bunch of messages in a certain amount of time, additional notifications are muted until the cooldown time ends.

## Installing

1. Download **Deckygram.zip** from Releases.
2. In Decky Loader's settings, turn on **Developer mode** if it isn't on already.
3. In the **Developer** section, choose **Install plugin from ZIP file** and pick Deckygram.zip.

<!-- If you plan to submit Deckygram to the Decky plugin store later, this section can say so. -->

## First run

- The first launch downloads the Electron browser runtime (about 280 MB once unpacked), so you'll need an internet connection and a few minutes.
- Deckygram then shows a QR code. On your phone, open Telegram and go to **Settings > Devices > Link Desktop Device** to scan it.
- Your login stays on your Deck, in Decky's plugin data folder. **Log out** in Deckygram's settings removes it.

## More Info

- Deckygram runs Telegram Web in a hidden browser and reads what it shows, so it only sees the chats and messages Telegram Web has loaded.
- Notifications only arrive while Deckygram is running.
- Animated stickers show as a still picture. Videos over 50 MB can't be played in Deckygram.
- The first time you open reactions, Deckygram switches off animated emoji in its own hidden Telegram Web so it can show reactions as emoji. This doesn't affect Telegram on your other devices.
- Other Decky plugins that change Steam notifications may affect how Deckygram's notifications look.

## Known issues

- Phone calls don't work, and I'm not really planning on fixing that, video calls too.
- This whole thing relies on an electron app running Telegram, so there may be some performance costs, but from what I noticed, not enough for me to notice too much.
- Sometimes it the app doesn't start up correctly, and the retry button needs to be clicked for it to start up correctly.

## Feedback

This is terrible. I am sitting on a throne of lies and spaghetti. If anything is broken, please let me know.

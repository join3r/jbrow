# jbrow

When you launch jbrow to check a change, run it in the background so it doesn't cover the user's
screen, take their keyboard focus or fight their own jbrow for ⌥Space:

```sh
JBROW_USER_DATA=<scratch dir> JBROW_BACKGROUND=1 node_modules/.bin/electron . --show --remote-debugging-port=<port>
```

The window is invisible there, so take screenshots over CDP (`Page.captureScreenshot` on the UI
target or a page target), never with `screencapture`. Leave out `JBROW_BACKGROUND` only when the
user asks to watch it, or when the change is about the window itself (animation, focus, click-away).

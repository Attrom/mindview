/* @mindview-mod
{
  "id": "coast",
  "name": "Coast",
  "version": "1.0.0",
  "kind": "usage",
  "description": "Sea-salt whites and soft blues.",
  "author": "Mindview",
  "tags": [
    "Theme"
  ],
  "base": "light",
  "icon": "M3 14c2-2 4-2 6 0s4 2 6 0M10 4l4 7H6z"
}
*/
Mindview.mod(api => {
  // a full theme: it sets every colour, so it looks the same whether you came from Dark or Light
  api.addStyle(`
    body.theme-dark, body.theme-light {
      --bg: #eef4f9;
      --grid-dot: rgba(20, 60, 110, .09);
      --card: #ffffff;
      --card-hover: #f8fbfe;
      --text: #1c2b3a;
      --text-dim: #64778a;
      --text-faint: #9aabbb;
      --line: #d7e2ec;
      --edge: #b3c4d4;
      --neutral: #c2d0dd;
      --chrome: rgba(255, 255, 255, .9);
      --chrome-border: rgba(20, 60, 110, .08);
      --chrome-hover: rgba(20, 60, 110, .05);
      --shadow: 0 1px 2px rgba(40, 30, 10, .06), 0 6px 20px rgba(40, 30, 10, .07);
      --shadow-lg: 0 12px 40px rgba(40, 30, 10, .16);
      --accent: #1f7fd1;
    }
  `);
});

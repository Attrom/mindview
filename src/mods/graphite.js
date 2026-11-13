/* @mindview-mod
{
  "id": "graphite",
  "name": "Graphite",
  "version": "2.0.0",
  "kind": "usage",
  "description": "Neutral greys with crisp white text, for maximum contrast.",
  "author": "Mindview",
  "tags": [
    "Theme"
  ],
  "base": "dark",
  "icon": "M4 16L13.500 6.500l2 2L6 18H4zM12 8l2 2M13.500 4.500l2 2"
}
*/
Mindview.mod(api => {
  // a full theme: it sets every colour, so it looks the same whether you came from Dark or Light
  api.addStyle(`
    body.theme-dark, body.theme-light {
      --bg: #0a0a0a;
      --grid-dot: rgba(255, 255, 255, .06);
      --card: #161616;
      --card-hover: #1d1d1d;
      --text: #ffffff;
      --text-dim: #a8a8a8;
      --text-faint: #6a6a6a;
      --line: #2a2a2a;
      --edge: #555555;
      --neutral: #4d4d4d;
      --chrome: rgba(20, 20, 20, .9);
      --chrome-border: rgba(255, 255, 255, .1);
      --chrome-hover: rgba(255, 255, 255, .08);
      --shadow: 0 1px 2px rgba(0, 0, 0, .35), 0 8px 24px rgba(0, 0, 0, .28);
      --shadow-lg: 0 12px 40px rgba(0, 0, 0, .5);
      --accent: #f2f2f2;
    }
  `);
});

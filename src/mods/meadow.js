/* @mindview-mod
{
  "id": "meadow",
  "name": "Meadow",
  "version": "1.0.0",
  "kind": "usage",
  "description": "Fresh leafy greens on a bright page.",
  "author": "Mindview",
  "tags": [
    "Theme"
  ],
  "base": "light",
  "icon": "M10 17V9M10 12c-3 0-5-2-5-5 3 0 5 2 5 5zM10 10c0-3 2-5 5-5 0 3-2 5-5 5z"
}
*/
Mindview.mod(api => {
  // a full theme: it sets every colour, so it looks the same whether you came from Dark or Light
  api.addStyle(`
    body.theme-dark, body.theme-light {
      --bg: #eef3ec;
      --grid-dot: rgba(20, 70, 30, .08);
      --card: #ffffff;
      --card-hover: #f8fbf6;
      --text: #1d2b20;
      --text-dim: #5f7564;
      --text-faint: #9bab9e;
      --line: #d6e2d4;
      --edge: #b0c4b0;
      --neutral: #c3d3c1;
      --chrome: rgba(255, 255, 255, .9);
      --chrome-border: rgba(20, 70, 30, .08);
      --chrome-hover: rgba(20, 70, 30, .05);
      --shadow: 0 1px 2px rgba(40, 30, 10, .06), 0 6px 20px rgba(40, 30, 10, .07);
      --shadow-lg: 0 12px 40px rgba(40, 30, 10, .16);
      --accent: #2f8f4a;
    }
  `);
});

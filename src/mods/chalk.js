/* @mindview-mod
{
  "id": "chalk",
  "name": "Chalk",
  "version": "1.0.0",
  "kind": "usage",
  "description": "Clean white and near-black, nothing else.",
  "author": "Mindview",
  "tags": [
    "Theme"
  ],
  "base": "light",
  "icon": "M5 15l8-8 2 2-8 8H5zM12.500 7.500l2 2"
}
*/
Mindview.mod(api => {
  // a full theme: it sets every colour, so it looks the same whether you came from Dark or Light
  api.addStyle(`
    body.theme-dark, body.theme-light {
      --bg: #f5f5f5;
      --grid-dot: rgba(0, 0, 0, .08);
      --card: #ffffff;
      --card-hover: #fafafa;
      --text: #0d0d0d;
      --text-dim: #5c5c5c;
      --text-faint: #9c9c9c;
      --line: #dedede;
      --edge: #a8a8a8;
      --neutral: #c4c4c4;
      --chrome: rgba(255, 255, 255, .92);
      --chrome-border: rgba(0, 0, 0, .1);
      --chrome-hover: rgba(0, 0, 0, .06);
      --shadow: 0 1px 2px rgba(40, 30, 10, .06), 0 6px 20px rgba(40, 30, 10, .07);
      --shadow-lg: 0 12px 40px rgba(40, 30, 10, .16);
      --accent: #111111;
    }
  `);
});

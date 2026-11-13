/* @mindview-mod
{
  "id": "paper",
  "name": "Paper",
  "version": "2.0.0",
  "kind": "usage",
  "description": "Warm off-white pages and ink, like a notebook.",
  "author": "Mindview",
  "tags": [
    "Theme"
  ],
  "base": "light",
  "icon": "M5.500 3h6l3 3v11h-9zM11.500 3v3h3M8 10h4.500M8 13h4.500"
}
*/
Mindview.mod(api => {
  // a full theme: it sets every colour, so it looks the same whether you came from Dark or Light
  api.addStyle(`
    body.theme-dark, body.theme-light {
      --bg: #efe7d8;
      --grid-dot: rgba(90, 60, 20, .09);
      --card: #fbf6ec;
      --card-hover: #fdf9f2;
      --text: #2e2418;
      --text-dim: #7a6a54;
      --text-faint: #ab9c84;
      --line: #e0d4bf;
      --edge: #c3b296;
      --neutral: #d3c4a9;
      --chrome: rgba(250, 244, 233, .92);
      --chrome-border: rgba(90, 60, 20, .1);
      --chrome-hover: rgba(90, 60, 20, .06);
      --shadow: 0 1px 2px rgba(40, 30, 10, .06), 0 6px 20px rgba(40, 30, 10, .07);
      --shadow-lg: 0 12px 40px rgba(40, 30, 10, .16);
      --accent: #b4532a;
    }
  `);
});

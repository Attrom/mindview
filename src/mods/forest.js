/* @mindview-mod
{
  "id": "forest",
  "name": "Forest",
  "version": "2.0.0",
  "kind": "usage",
  "description": "Deep greens and moss.",
  "author": "Mindview",
  "tags": [
    "Theme"
  ],
  "base": "dark",
  "icon": "M10 3l5 7h-3l4 5H4l4-5H5zM10 15v2.500"
}
*/
Mindview.mod(api => {
  // a full theme: it sets every colour, so it looks the same whether you came from Dark or Light
  api.addStyle(`
    body.theme-dark, body.theme-light {
      --bg: #0e1511;
      --grid-dot: rgba(160, 230, 180, .055);
      --card: #16211a;
      --card-hover: #1b2820;
      --text: #e1ece3;
      --text-dim: #8aa192;
      --text-faint: #566a5c;
      --line: #22332a;
      --edge: #3d5546;
      --neutral: #3c5244;
      --chrome: rgba(19, 29, 23, .88);
      --chrome-border: rgba(190, 255, 210, .07);
      --chrome-hover: rgba(190, 255, 210, .07);
      --shadow: 0 1px 2px rgba(0, 0, 0, .35), 0 8px 24px rgba(0, 0, 0, .28);
      --shadow-lg: 0 12px 40px rgba(0, 0, 0, .5);
      --accent: #6fcf86;
    }
  `);
});

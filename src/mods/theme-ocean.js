/* @mindview-mod
{
  "id": "theme-ocean",
  "name": "Ocean",
  "version": "2.0.0",
  "kind": "usage",
  "description": "Deep navy with a bright sky-blue accent.",
  "author": "Mindview",
  "tags": [
    "Theme"
  ],
  "base": "dark",
  "icon": "M2.5 7.5c1.7-2 3.3-2 5 0s3.300 2 5 0s3.300-2 5 0M2.5 12.5c1.7-2 3.3-2 5 0s3.300 2 5 0s3.300-2 5 0"
}
*/
Mindview.mod(api => {
  // a full theme: it sets every colour, so it looks the same whether you came from Dark or Light
  api.addStyle(`
    body.theme-dark, body.theme-light {
      --bg: #0d1722;
      --grid-dot: rgba(140, 190, 255, .07);
      --card: #152434;
      --card-hover: #1a2c40;
      --text: #dfeaf5;
      --text-dim: #8aa0b6;
      --text-faint: #57697c;
      --line: #22364a;
      --edge: #3d5670;
      --neutral: #3f566e;
      --chrome: rgba(17, 30, 44, .88);
      --chrome-border: rgba(160, 200, 255, .08);
      --chrome-hover: rgba(160, 200, 255, .07);
      --shadow: 0 1px 2px rgba(0, 0, 0, .35), 0 8px 24px rgba(0, 0, 0, .28);
      --shadow-lg: 0 12px 40px rgba(0, 0, 0, .5);
      --accent: #4fb3ff;
    }
  `);
});

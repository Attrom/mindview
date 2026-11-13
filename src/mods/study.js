/* @mindview-mod
{
  "id": "study",
  "name": "Study",
  "version": "1.0.0",
  "kind": "usage",
  "description": "A dim desk at night: warm browns and a terracotta accent.",
  "author": "Mindview",
  "tags": [
    "Theme"
  ],
  "base": "dark",
  "icon": "M4 9h12M5 9v8M15 9v8M8 9V6h4v3"
}
*/
Mindview.mod(api => {
  // a full theme: it sets every colour, so it looks the same whether you came from Dark or Light
  api.addStyle(`
    body.theme-dark, body.theme-light {
      --bg: #1a1714;
      --grid-dot: rgba(255, 235, 200, .05);
      --card: #24201c;
      --card-hover: #2a2520;
      --text: #ede3d3;
      --text-dim: #a39784;
      --text-faint: #6d6455;
      --line: #352f28;
      --edge: #574e42;
      --neutral: #4f473c;
      --chrome: rgba(36, 32, 28, .9);
      --chrome-border: rgba(255, 235, 200, .08);
      --chrome-hover: rgba(255, 235, 200, .07);
      --shadow: 0 1px 2px rgba(0, 0, 0, .35), 0 8px 24px rgba(0, 0, 0, .28);
      --shadow-lg: 0 12px 40px rgba(0, 0, 0, .5);
      --accent: #d9774b;
    }
  `);
});

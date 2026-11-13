/* @mindview-mod
{
  "id": "night-shift",
  "name": "Night shift",
  "version": "2.0.0",
  "kind": "usage",
  "description": "Warm amber on near black with almost no blue light, for late evenings. Note colours and pictures are shifted to warm tones too.",
  "author": "Mindview",
  "tags": [
    "Theme"
  ],
  "base": "dark",
  "icon": "M14.5 12.500A6 6 0 0 1 7.5 5.500a6 6 0 1 0 7 7zM14 3.500v2M13 4.500h2"
}
*/
Mindview.mod(api => {
  // a full theme: it sets every colour, so it looks the same whether you came from Dark or Light
  api.addStyle(`
    body.theme-dark, body.theme-light {
      --bg: #0d0805;
      --grid-dot: rgba(255, 150, 60, .06);
      --card: #1a0f07;
      --card-hover: #211309;
      --text: #ffb066;
      --text-dim: #b2753d;
      --text-faint: #6e4524;
      --line: #2c1a0b;
      --edge: #5a3612;
      --neutral: #4a2d10;
      --chrome: rgba(24, 14, 6, .9);
      --chrome-border: rgba(255, 150, 60, .1);
      --chrome-hover: rgba(255, 150, 60, .09);
      --shadow: 0 1px 2px rgba(0, 0, 0, .5), 0 8px 24px rgba(0, 0, 0, .4);
      --shadow-lg: 0 12px 40px rgba(0, 0, 0, .6);
      --accent: #ff8a1f;
    }
  `);
  // the canvas also has note colours and pictures: a colour filter takes the remaining blue out of everything
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute';
  svg.innerHTML = '<filter id="mv-night-shift" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0.7 0.25 0.1 0 0  0.1 0.55 0.1 0 0  0 0 0.03 0 0  0 0 0 1 0"/></filter>';
  api.addElement(svg);
  api.addStyle('html { filter: url(#mv-night-shift); }');
});

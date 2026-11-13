/* @mindview-mod
{
  "id": "plum",
  "name": "Plum",
  "version": "2.0.1",
  "kind": "usage",
  "description": "Dusky purples with a soft rose accent, in both Dark and Light.",
  "author": "Mindview",
  "tags": [
    "Theme"
  ],
  "partial": true,
  "icon": "M10 6c-3 0-5 2.500-5 5.500S7 17 10 17s5-2.500 5-5.500S13 6 10 6zM10 6c0-1.500.8-2.500 2.500-3"
}
*/
Mindview.mod(api => {
  // an accent: it changes only some colours, on top of the theme in use (html body... so it wins over a full theme)
  api.addStyle(`
    html body.theme-dark { --bg: #140f17; --grid-dot: rgba(230, 190, 255, .055); --card: #1e1723; --card-hover: #241c2a; --text: #eee3f2; --text-dim: #a291aa; --text-faint: #6a5b71; --line: #2f2536; --edge: #4f4058; --neutral: #4a3c52; --chrome: rgba(30, 23, 35, .9); --chrome-border: rgba(240, 210, 255, .08); --chrome-hover: rgba(240, 210, 255, .07); --accent: #f08bb4; }
    html body.theme-light { --bg: #f4eff6; --grid-dot: rgba(70, 20, 90, .08); --card: #ffffff; --card-hover: #fcf9fd; --text: #2a1d30; --text-dim: #77657e; --text-faint: #a99bb0; --line: #e4dae8; --edge: #c6b5cd; --neutral: #d4c6da; --chrome: rgba(255, 255, 255, .9); --chrome-border: rgba(70, 20, 90, .08); --chrome-hover: rgba(70, 20, 90, .05); --accent: #c2477c; }
  `);
});

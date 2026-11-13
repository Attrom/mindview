/* @mindview-mod
{
  "id": "accent-rose",
  "name": "Rose",
  "version": "1.0.2",
  "kind": "usage",
  "description": "Keeps Dark or Light as it is and only makes the accent rose.",
  "author": "Mindview",
  "tags": [
    "Theme"
  ],
  "partial": true,
  "icon": "M10 16s-6-3.500-6-8a3.200 3.200 0 0 1 6-1.500A3.200 3.200 0 0 1 16 8c0 4.500-6 8-6 8z"
}
*/
Mindview.mod(api => {
  // an accent: it changes only some colours, on top of the theme in use (html body... so it wins over a full theme)
  api.addStyle(`
    html body.theme-dark { --accent: #f07c9a; }
    html body.theme-light { --accent: #d24a6e; }
  `);
});

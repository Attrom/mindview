/* @mindview-mod
{
  "id": "accent-teal",
  "name": "Teal",
  "version": "1.0.2",
  "kind": "usage",
  "description": "Keeps Dark or Light as it is and only makes the accent teal.",
  "author": "Mindview",
  "tags": [
    "Theme"
  ],
  "partial": true,
  "icon": "M10 3.500a6.500 6.500 0 1 0 0 13a6.500 6.500 0 0 0 0-13zM10 7v6M7 10h6"
}
*/
Mindview.mod(api => {
  // an accent: it changes only some colours, on top of the theme in use (html body... so it wins over a full theme)
  api.addStyle(`
    html body.theme-dark { --accent: #3ec1b5; }
    html body.theme-light { --accent: #14998c; }
  `);
});

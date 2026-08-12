export class HTMLParser {
  ids = [];
  feed(html) {
    for (const match of html.matchAll(/\sid=["']([^"']+)["']/g)) this.ids.push(match[1]);
  }
}

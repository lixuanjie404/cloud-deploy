/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { htmlContent } from "./readnew.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let glhInfo;
    if (url.pathname === '/readnews') {
      var urlencoded = new URLSearchParams();
      urlencoded.append("name", "glh");
      urlencoded.append("msgtype", "all");

      var requestOptions = {
        method: 'POST',
        headers: {

        },
        body: urlencoded,
        redirect: 'follow'
      };
      await fetch("https://duanxianxia.com/api/getNewsByList", requestOptions)
        .then(response => response.json())
        .then(result => {
          console.log(result);
          glhInfo = result.html;
        })
        .catch(error => console.log('error', error));
      return new Response(glhInfo, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=UTF-8',
          'X-Custom-Header': 'CustomValue'
        }
      });
    } else if (url.pathname === '/test') {
      return new Response(htmlContent, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=UTF-8',
          'X-Custom-Header': 'CustomValue'
        }
      });
    }

    return new Response('Hello World!');
  },
};

function pageEnv() {
  var container = document.documentElement

  function fallback(html) {
    var noscripts = document.getElementsByTagName('noscript')
    if (noscripts.length > 0) {
      html = noscripts[0].innerHTML
    }
    container.innerHTML = html
  }

  var jsUrl = document.currentScript.src
  var sw = navigator.serviceWorker
  if (!sw) {
    fallback('Service Worker is not supported')
    return
  }
  var rootPath = getRootPath(jsUrl)


  function unpackToCache(bytes, cache) {
    var pendings = []

    if (!sw.controller) {
      var swPending = sw.register(jsUrl, {scope: getRootPath(jsUrl)}).catch(function(err) {
        fallback(err.message)
      })
      pendings.push(swPending)
    }

    var info = JSON.stringify({
      hash: HASH,
      time: Date.now()
    })
    var res = new Response(info)
    pendings.push(
      cache.put(rootPath + '.cache-info', res),
    )

    var pathResMap = unpack(bytes)

    for (var path in pathResMap) {
      res = pathResMap[path]
      pendings.push(
        cache.put(rootPath + path, res)
      )
    }
    Promise.all(pendings).then(function() {
      // location.reload()
      location.replace(getRootPath(jsUrl))
    })
  }

  function parseImgBuf(buf) {
    if (!buf) {
      loadNextUrl()
      return
    }
    crypto.subtle.digest('SHA-256', buf).then(function(digest) {
      var hashBin = new Uint8Array(digest)
      var hashB64 = btoa(String.fromCharCode.apply(null, hashBin))
      if (HASH && HASH !== hashB64) {
        console.warn('[web2img] bad hash. exp:', HASH, 'but got:', hashB64)
        loadNextUrl()
        return
      }
      var bytes = decode1Px3Bytes(buf)
      caches.delete('.web2img').then(function() {
        caches.open('.web2img').then(function(cache) {
          unpackToCache(bytes, cache)
        })
      })
    })
  }

  // run in iframe
  var loadImg = function(e) {
    var opt = e.data
    var img = new Image()

    img.onload = function() {
      clearInterval(tid)

      var canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height

      var ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)

      var imgData = ctx.getImageData(0, 0, img.width, img.height)
      var buf = imgData.data.buffer

      if (opt.privacy === 2) {
        parent.postMessage(buf, '*', [buf])
      } else {
        parseImgBuf(buf)
      }
    }

    img.onerror = function() {
      clearInterval(tid)

      if (opt.privacy === 2) {
        parent.postMessage('', '*')
      } else {
        parseImgBuf()
      }
    }
    if (opt.privacy === 1) {
      img.referrerPolicy = 'no-referrer'
    }
    img.crossOrigin = 1
    img.src = opt.url

    var tid = setTimeout(function() {
      console.log('[web2img] timeout:', opt.url)
      img.onerror()
      img.onerror = img.onload = null
      img.src = ''
    }, opt.timeout)
  }

  if (PRIVACY === 2) {
    // hide `origin` header
    var iframe = document.createElement('iframe')

    if (typeof RELEASE !== 'undefined') {
      iframe.src = 'data:text/html,<script>onmessage=' + loadImg + '</script>'
    } else {
      iframe.src = 'data:text/html;base64,' + btoa('<script>onmessage=' + loadImg + '</script>')
    }
    iframe.style.display = 'none'
    iframe.onload = loadNextUrl

    container.appendChild(iframe)
    var iframeWin = iframe.contentWindow

    self.onmessage = function(e) {
      if (e.source === iframeWin) {
        parseImgBuf(e.data)
      }
    }
  } else {
    loadNextUrl()
  }

  function loadNextUrl() {
    var url = URLS.shift()
    if (!url) {
      fallback('failed to load resources')
      return
    }
    var opt = {
      url: url,
      privacy: PRIVACY,
      timeout: IMG_TIMEOUT * 1000
    }
    if (PRIVACY === 2) {
      iframeWin.postMessage(opt, '*')
    } else {
      loadImg({data: opt})
    }
  }

  function decode1Px3Bytes(pixelBuf) {
    var u32 = new Uint32Array(pixelBuf)
    var out = new Uint8Array(u32.length * 3)
    var p = 0
    u32.forEach(function(rgba) {
      out[p++] = rgba
      out[p++] = rgba >>  8
      out[p++] = rgba >> 16
    })
    return out
  }

  function unpack(bytes) {
    var confEnd = bytes.indexOf(13)   // '\r'
    var confBin = bytes.subarray(0, confEnd)
    var confStr = new TextDecoder().decode(confBin)
    var confObj = JSON.parse(confStr)

    var offset = confEnd + 1

    for (var path in confObj) {
      var headers = confObj[path]
      var expires = /\.html$/.test(path) ? 5 : UPDATE_INTERVAL
      headers['cache-control'] = 'max-age=' + expires

      var len = +headers['content-length']
      var bin = bytes.subarray(offset, offset + len)

      confObj[path] = new Response(bin, {
        headers: headers
      })
      offset += len
    }
    return confObj
  }
}

function swEnv() {
  var jsUrl = location.href.split('?')[0]
  var rootPath = getRootPath(jsUrl)
  var isFirst = 1
  var newJs

  function openFile(path) {
    return caches.open('.web2img').then(function(cache) {
      return cache.match(path)
    })
  }

  function checkUpdate() {
    openFile(rootPath + '.cache-info').then(function(res) {
      if (!res) {
        return
      }
      res.json().then(function(info) {
        if (Date.now() - info.time < 1000 * UPDATE_INTERVAL) {
          return
        }
        var url, opt
        if ('cache' in Request.prototype) {
          url = jsUrl
          opt = {cache: 'no-cache'}
        } else {
          url = jsUrl + '?t=' + Date.now()
        }
        fetch(url, opt).then(function(res) {
          res.text().then(function(js) {
            if (js.indexOf(info.hash) === -1) {
              newJs = url
              console.log('[web2img] new version found')
            }
          })
        })
      })
    })
  }
  setInterval(checkUpdate, 1000 * UPDATE_INTERVAL)

  function respondFile(url) {
    var path = new URL(url).pathname
      .replace(/\/{2,}/g, '/')
      .replace(/\/$/, '/index.html')

    return openFile(path).then(function(r1) {
      return r1 || openFile(rootPath + '404.html').then(function(r2) {
        return r2 || new Response('file not found: ' + path, {
          status: 404
        })
      })
    })
  }

  function respond(req) {
    return caches.has('.web2img').then(function(existed) {
      if (!existed) {
        // fix cache
        newJs = jsUrl
      }
      if (newJs && req.mode === 'navigate') {
        var res = new Response('<script src=' + newJs + '></script>', {
          headers: {
            'content-type': 'text/html'
          }
        })
        newJs = ''
        console.log('[web2img] updating')
        return res
      }
      return respondFile(req.url)
    })
  }

  onfetch = function(e) {
    if (isFirst) {
      isFirst = 0
      checkUpdate()
    }
    var req = e.request
    if (req.url.indexOf(rootPath) === 0 && req.url.indexOf(jsUrl) !== 0) {
      // url starts with rootPath (exclude x.js)
      e.respondWith(respond(req))
    }
  }

  oninstall = function() {
    skipWaiting()
  }
}

function getRootPath(url) {
  // e.g.
  // 'https://mysite.com/'
  // 'https://xx.github.io/path/to/'
  return url.split('?')[0].replace(/[^/]+$/, '') + (PATH_PREFIX ? PATH_PREFIX + '/' : '')

}

if (self.document) {
  pageEnv()
} else {
  swEnv()
}
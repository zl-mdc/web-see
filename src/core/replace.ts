import {
  _global,
  on,
  getTimestamp,
  replaceAop,
  throttle,
  getLocationHref,
  isExistProperty,
  variableTypeDetection,
  supportsHistory,
} from '../utils';
import { transportData, options, triggerHandlers, subscribeEvent } from './index';
import { EVENTTYPES, HTTPTYPE, EMethods } from '../common';
import { ReplaceHandler, voidFun } from '../types';

// 判断当前接口是否为需要过滤掉的接口
function isFilterHttpUrl(url: string): boolean {
  return options.filterXhrUrlRegExp && options.filterXhrUrlRegExp.test(url);
}
function replace(type: EVENTTYPES): void {
  switch (type) {
    case EVENTTYPES.WHITESCREEN:
      whiteScreen();
      break;
    case EVENTTYPES.XHR:
      xhrReplace();
      break;
    case EVENTTYPES.FETCH:
      fetchReplace();
      break;
    case EVENTTYPES.ERROR:
      listenError();
      break;
    case EVENTTYPES.HISTORY:
      historyReplace();
      break;
    case EVENTTYPES.UNHANDLEDREJECTION:
      unhandledrejectionReplace();
      break;
    case EVENTTYPES.CLICK:
      domReplace();
      break;
    case EVENTTYPES.HASHCHANGE:
      listenHashchange();
      break;
    case EVENTTYPES.PERFORMANCE:
      listenPerformance();
      break;
    case EVENTTYPES.RECORDSCREEN:
      recordScreen();
      break;
    default:
      break;
  }
}
export function addReplaceHandler(handler: ReplaceHandler): void {
  if (!subscribeEvent(handler)) return;
  replace(handler.type);
}
function xhrReplace(): void {
  if (!('XMLHttpRequest' in _global)) {
    return;
  }
  const originalXhrProto = XMLHttpRequest.prototype;
  replaceAop(originalXhrProto, 'open', (originalOpen: voidFun) => {
    return function (...args: any[]): void {
      this.websee_xhr = {
        method: variableTypeDetection.isString(args[0]) ? args[0].toUpperCase() : args[0],
        url: args[1],
        sTime: getTimestamp(),
        type: HTTPTYPE.XHR,
      };
      originalOpen.apply(this, args);
    };
  });
  replaceAop(originalXhrProto, 'send', (originalSend: voidFun) => {
    return function (...args: any[]): void {
      const { method, url } = this.websee_xhr;
      // 监听loadend事件，接口成功或失败都会执行
      on(this, 'loadend', function () {
        // isSdkTransportUrl 判断当前接口是否为上报的接口
        // isFilterHttpUrl 判断当前接口是否为需要过滤掉的接口
        if (
          (method === EMethods.Post && transportData.isSdkTransportUrl(url)) ||
          isFilterHttpUrl(url)
        )
          return;
        const { responseType, response, status } = this;
        this.websee_xhr.requestData = args[0];
        const eTime = getTimestamp();
        // 设置该接口的time，用户用户行为按时间排序
        this.websee_xhr.time = this.websee_xhr.sTime;
        this.websee_xhr.Status = status;
        if (['', 'json', 'text'].indexOf(responseType) !== -1) {
          // 用户设置handleHttpStatus函数来判断接口是否正确，只有接口报错时才保留response
          if (options.handleHttpStatus && typeof options.handleHttpStatus == 'function') {
            this.websee_xhr.response = response && JSON.parse(response);
          }
        }
        // 接口的执行时长
        this.websee_xhr.elapsedTime = eTime - this.websee_xhr.sTime;
        // 执行之前注册的xhr回调函数
        triggerHandlers(EVENTTYPES.XHR, this.websee_xhr);
      });
      originalSend.apply(this, args);
    };
  });
}
function fetchReplace(): void {
  if (!('fetch' in _global)) {
    return;
  }
  replaceAop(_global, EVENTTYPES.FETCH, (originalFetch: voidFun) => {
    return function (url, config: Partial<Request> = {}): void {
      const sTime = getTimestamp();
      const method = (config && config.method) || 'GET';
      let fetchData = {
        type: HTTPTYPE.FETCH,
        method,
        requestData: config && config.body,
        url,
        response: '',
      };
      // 获取配置的headers
      const headers = new Headers(config.headers || {});
      Object.assign(headers, {
        setRequestHeader: headers.set,
      });
      config = Object.assign({}, config, headers);
      return originalFetch.apply(_global, [url, config]).then(
        res => {
          // 克隆一份，防止被标记已消费
          const tempRes = res.clone();
          const eTime = getTimestamp();
          fetchData = Object.assign({}, fetchData, {
            elapsedTime: eTime - sTime,
            Status: tempRes.status,
            time: sTime,
          });
          tempRes.text().then(data => {
            // 同理，进接口进行过滤
            if (
              (method === EMethods.Post && transportData.isSdkTransportUrl(url)) ||
              isFilterHttpUrl(url)
            )
              return;
            // 用户设置handleHttpStatus函数来判断接口是否正确，只有接口报错时才保留response
            if (options.handleHttpStatus && typeof options.handleHttpStatus == 'function') {
              fetchData.response = data;
            }
            triggerHandlers(EVENTTYPES.FETCH, fetchData);
          });
          return res;
        },
        // 接口报错
        err => {
          const eTime = getTimestamp();
          if (
            (method === EMethods.Post && transportData.isSdkTransportUrl(url)) ||
            isFilterHttpUrl(url)
          )
            return;
          fetchData = Object.assign({}, fetchData, {
            elapsedTime: eTime - sTime,
            status: 0,
            time: sTime,
          });
          triggerHandlers(EVENTTYPES.FETCH, fetchData);
          throw err;
        }
      );
    };
  });
}
function listenHashchange(): void {
  // 通过onpopstate事件，来监听hash模式下路由的变化
  if (isExistProperty(_global, 'onhashchange')) {
    on(_global, EVENTTYPES.HASHCHANGE, function (e: HashChangeEvent) {
      triggerHandlers(EVENTTYPES.HASHCHANGE, e);
    });
  }
}

function listenError(): void {
  on(
    _global,
    'error',
    function (e: ErrorEvent) {
      console.log(e);
      triggerHandlers(EVENTTYPES.ERROR, e);
    },
    true
  );
}

// last time route
let lastHref: string = getLocationHref();
function historyReplace(): void {
  // 是否支持history
  if (!supportsHistory()) return;
  const oldOnpopstate = _global.onpopstate;
  // 添加 onpopstate事件
  _global.onpopstate = function (...args: any[]): void {
    const to = getLocationHref();
    const from = lastHref;
    lastHref = to;
    triggerHandlers(EVENTTYPES.HISTORY, {
      from,
      to,
    });
    oldOnpopstate && oldOnpopstate.apply(this, args);
  };
  function historyReplaceFn(originalHistoryFn: voidFun): voidFun {
    return function (...args: any[]): void {
      const url = args.length > 2 ? args[2] : undefined;
      if (url) {
        const from = lastHref;
        const to = String(url);
        lastHref = to;
        triggerHandlers(EVENTTYPES.HISTORY, {
          from,
          to,
        });
      }
      return originalHistoryFn.apply(this, args);
    };
  }
  // 重写pushState、replaceState事件
  replaceAop(_global.history, 'pushState', historyReplaceFn);
  replaceAop(_global.history, 'replaceState', historyReplaceFn);
}
function unhandledrejectionReplace(): void {
  on(_global, EVENTTYPES.UNHANDLEDREJECTION, function (ev: PromiseRejectionEvent) {
    // ev.preventDefault() 阻止默认行为后，控制台就不会再报红色错误
    triggerHandlers(EVENTTYPES.UNHANDLEDREJECTION, ev);
  });
}
function domReplace(): void {
  if (!('document' in _global)) return;
  // 节流，默认0s
  const clickThrottle = throttle(triggerHandlers, options.throttleDelayTime);
  on(
    _global.document,
    'click',
    function (): void {
      clickThrottle(EVENTTYPES.CLICK, {
        category: 'click',
        data: this,
      });
    },
    true
  );
}
function listenPerformance(): void {
  triggerHandlers(EVENTTYPES.PERFORMANCE);
}

function recordScreen(): void {
  triggerHandlers(EVENTTYPES.RECORDSCREEN);
}
function whiteScreen(): void {
  triggerHandlers(EVENTTYPES.WHITESCREEN);
}

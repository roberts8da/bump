const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

// --- [配置项] ---
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const SERVER_URL = process.env.SERVER_URL ? process.env.SERVER_URL.trim() : '';
const HTTP_PROXY = process.env.HTTP_PROXY;

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// 延迟小工具
const delay = ms => new Promise(res => setTimeout(res, ms));

// 截图小工具
async function snap(page, label) {
    try {
        const file = path.join(SCREENSHOT_DIR, `${Date.now()}_${label}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`📸 已保存截图: ${label}`);
    } catch (e) {
        console.error(`⚠️ 截图失败 (${label}):`, e.message);
    }
}

// 提取用户配置
function getUsers() {
    const raw = process.env.USERS_JSON || '';
    if (!raw) return [];
    try {
        if (raw.trim().startsWith('[')) return JSON.parse(raw);
    } catch (e) {}
    return raw.split('\n').map(line => {
        const [username, password] = line.trim().split(':');
        return (username && password) ? { username: username.trim(), password: password.trim() } : null;
    }).filter(Boolean);
}

// 发送 Telegram 消息
async function sendTGMessage(msg) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log("⚠️ 未配置 TG_BOT_TOKEN 或 TG_CHAT_ID，跳过发送 TG 通知。");
        return;
    }
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TG_CHAT_ID,
                text: msg,
                parse_mode: 'HTML'
            })
        });
        if (res.ok) {
            console.log("📨 TG 通知发送成功！");
        } else {
            console.error("❌ TG 通知发送失败:", await res.text());
        }
    } catch (e) {
        console.error("❌ 发送 TG 通知出错:", e.message);
    }
}

// 提取页面上的 Expiry (到期时间)
async function getExpiryDate(page) {
    return await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('*'));
        for (let el of allElements) {
            if (el.children.length === 0 && el.textContent.trim() === 'Expiry') {
                let sibling = el.nextElementSibling;
                while (sibling) {
                    const txt = sibling.textContent.trim();
                    if (/\d{4}-\d{2}-\d{2}/.test(txt)) {
                        return txt.match(/\d{4}-\d{2}-\d{2}/)[0];
                    }
                    sibling = sibling.nextElementSibling;
                }
                const parent = el.parentElement;
                if (parent) {
                    for (let sib of parent.children) {
                        const txt = sib.textContent.trim();
                        if (/\d{4}-\d{2}-\d{2}/.test(txt)) {
                            return txt.match(/\d{4}-\d{2}-\d{2}/)[0];
                        }
                    }
                }
            }
        }
        const bodyText = document.body.innerText;
        const match = bodyText.match(/Expiry\s+([0-9]{4}-[0-9]{2}-[0-9]{2})/i) || bodyText.match(/Expiry\s*:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
        if (match) return match[1];
        return null;
    });
}

// 提取页面上的红字警告提示
async function getWarningMessage(page) {
    return await page.evaluate(() => {
        const errorSelectors = [
            '[class*="danger"]', '[class*="error"]', '[class*="alert"]', 
            '[class*="red"]', '.bg-red-100', '.text-red-500', '.bg-red-500'
        ];
        for (let selector of errorSelectors) {
            const elements = Array.from(document.querySelectorAll(selector));
            for (let el of elements) {
                const txt = el.textContent.trim();
                if (txt && txt.length > 5 && (txt.includes("can't") || txt.includes("cannot") || txt.includes("yet") || txt.includes("renew") || txt.includes("able to"))) {
                    return txt;
                }
            }
        }
        const divs = Array.from(document.querySelectorAll('div, p, span'));
        for (let d of divs) {
            const txt = d.textContent.trim();
            if (txt && (txt.includes("You can't renew") || txt.includes("You will be able to"))) {
                return txt;
            }
        }
        return null;
    });
}

// 辅助函数：根据按钮文本检查是否可见
async function isBtnVisibleByText(page, text) {
    return await page.evaluate((txt) => {
        const elements = Array.from(document.querySelectorAll('button, a'));
        const btn = elements.find(el => {
            if (!el.textContent.trim().includes(txt)) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0;
        });
        return !!btn;
    }, text).catch(() => false);
}

// 辅助函数：点击主页面按钮
async function clickBtnByText(page, text) {
    return await page.evaluate((txt) => {
        const elements = Array.from(document.querySelectorAll('button, a'));
        const btn = elements.find(el => el.textContent.trim().includes(txt));
        if (btn) {
            btn.click();
            return true;
        }
        return false;
    }, text).catch(() => false);
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.error("❌ 未检测到合法的 USERS_JSON 配置");
        process.exit(1);
    }

    const connectOptions = { 
        headless: false, 
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', 
            '--window-size=1280,720'
        ],
        customConfig: {},
        turnstile: true, 
        connectOption: {
            defaultViewport: { width: 1280, height: 720 }
        },
        disableXvfb: true, 
        ignoreAllFlags: false
    };

    if (HTTP_PROXY) {
        try {
            const proxyUrl = new URL(HTTP_PROXY);
            connectOptions.proxy = {
                host: proxyUrl.hostname,
                port: parseInt(proxyUrl.port)
            };
            connectOptions.args.push(`--proxy-server=socks5://${proxyUrl.hostname}:${proxyUrl.port}`);
            console.log(`📡 代理已配置为: socks5://${proxyUrl.hostname}:${proxyUrl.port}`);
        } catch (e) {
            console.error("⚠️ 代理解析失败，继续使用直连模式:", e.message);
        }
    }

    let browser, firstPage;
    try {
        console.log(">> 正在初始化真实指纹浏览器...");
        const response = await connect(connectOptions);
        browser = response.browser;
        firstPage = response.page;
        console.log("✅ 浏览器创建成功");
    } catch (err) {
        console.error("❌ 浏览器启动失败，异常中断:", err.message);
        process.exit(1);
    }

    let isFirstUser = true;
    for (let user of users) {
        let page;
        try {
            if (isFirstUser) {
                page = firstPage;
                isFirstUser = false;
            } else {
                page = await browser.newPage();
            }

            await page.setViewport({ width: 1280, height: 720 }).catch(() => {});

            // 1. 登录流程
            console.log(`=== 处理用户: ${user.username} ===`);
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded' });
            await snap(page, `${user.username}_01_login_page`);

            await page.waitForSelector('input[type="email"]', { timeout: 15000 });
            await page.waitForSelector('input[type="password"]', { timeout: 15000 });

            await page.focus('input[type="email"]');
            await page.evaluate(() => document.querySelector('input[type="email"]').value = '');
            await page.type('input[type="email"]', user.username, { delay: 100 });

            await page.focus('input[type="password"]');
            await page.evaluate(() => document.querySelector('input[type="password"]').value = '');
            await page.type('input[type="password"]', user.password, { delay: 100 });

            const checkedEmail = await page.$eval('input[type="email"]', el => el.value);
            const checkedPassword = await page.$eval('input[type="password"]', el => el.value);

            if (checkedEmail !== user.username || checkedPassword !== user.password) {
                console.log("⚠️ 检测到模拟输入丢失字符，正在进行强制修正...");
                await page.evaluate((u, p) => {
                    const emailEl = document.querySelector('input[type="email"]');
                    const passEl = document.querySelector('input[type="password"]');
                    emailEl.value = u;
                    emailEl.dispatchEvent(new Event('input', { bubbles: true }));
                    emailEl.dispatchEvent(new Event('change', { bubbles: true }));
                    passEl.value = p;
                    passEl.dispatchEvent(new Event('input', { bubbles: true }));
                    passEl.dispatchEvent(new Event('change', { bubbles: true }));
                }, user.username, user.password);
            }

            await snap(page, `${user.username}_02_filled_form`);

            console.log(">> 等待 Cloudflare 自动检测 & Token 就绪...");
            let isVerified = false;
            for (let i = 0; i < 15; i++) {
                const hasToken = await page.evaluate(() => {
                    const el = document.querySelector('[name="cf-turnstile-response"]');
                    return el && el.value && el.value.length > 20;
                }).catch(() => false);

                if (hasToken) {
                    console.log("✅ Cloudflare 验证通过");
                    isVerified = true;
                    break;
                }
                await delay(2000);
            }

            await snap(page, `${user.username}_03_after_token_wait`);

            await page.click('button[type="submit"]');
            await delay(8000); 
            await snap(page, `${user.username}_04_after_submit`);

            // 2. 获取续期前参数
            if (SERVER_URL) {
                await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded' });
                await delay(3000); 
                await snap(page, `${user.username}_05_server_page`);
            }

            const expiryBefore = await getExpiryDate(page);
            console.log(`>> 续期前到期时间为: ${expiryBefore || "未能读取到日期"}`);

            let warningMsg = null;
            let expiryAfter = null;

            // 3. 执行续期弹窗与 ALTCHA 验证
            if (await isBtnVisibleByText(page, "Renew")) {
                console.log(">> 找到主页面 Renew 按钮，开始点击打开弹窗...");
                await clickBtnByText(page, "Renew");
                await delay(1000); // 预留短暂动画时间
                await snap(page, `${user.username}_06_modal_opened`);

                console.log(">> 正在寻找 ALTCHA 验证框并尝试进行安全点击...");
                let altchaClicked = false;

                // 物理防御 1：动态等待原生 Shadow DOM 穿透选择器检测到复选框并点击
                try {
                    const checkbox = await page.waitForSelector('altcha-widget >>> input[type="checkbox"]', { timeout: 4000 });
                    if (checkbox) {
                        await checkbox.click();
                        console.log("✅ 原生 Shadow DOM 选择器点击成功！");
                        altchaClicked = true;
                    }
                } catch (e) {
                    console.log("⚠️ 穿透选择器超时，准备尝试 JS 深度穿透...");
                }

                // 物理防御 2：JS 深度递归遍历 Shadow Tree 节点查找 input 进行点击
                if (!altchaClicked) {
                    try {
                        const clicked = await page.evaluate(() => {
                            const widget = document.querySelector('altcha-widget');
                            if (widget) {
                                const findCheckbox = (root) => {
                                    if (!root) return null;
                                    const el = root.querySelector('input[type="checkbox"]');
                                    if (el) return el;
                                    const all = Array.from(root.querySelectorAll('*'));
                                    for (let child of all) {
                                        if (child.shadowRoot) {
                                            const found = findCheckbox(child.shadowRoot);
                                            if (found) return found;
                                        }
                                    }
                                    return null;
                                };
                                let checkbox = widget.shadowRoot ? widget.shadowRoot.querySelector('input[type="checkbox"]') : null;
                                if (!checkbox) {
                                    checkbox = findCheckbox(widget);
                                }
                                if (checkbox) {
                                    checkbox.click();
                                    return "js_shadow_clicked";
                                }
                                const container = widget.shadowRoot ? widget.shadowRoot.querySelector('.altcha-checkbox') : null;
                                if (container) {
                                    container.click();
                                    return "js_container_clicked";
                                }
                            }
                            return "not_found";
                        });
                        if (clicked !== "not_found") {
                            console.log(`✅ JS 深度穿透点击成功 (${clicked})！`);
                            altchaClicked = true;
                        }
                    } catch (e) {
                        console.log("⚠️ JS 深度穿透失败，尝试物理坐标直接点击...");
                    }
                }

                // 物理防御 3：屏幕坐标兜底。获取 altcha-widget 的 bounding box，往其 Checkbox 的视觉中心位置无缝点击
                if (!altchaClicked) {
                    try {
                        const widget = await page.$('altcha-widget');
                        if (widget) {
                            const box = await widget.boundingBox();
                            if (box) {
                                const clickX = box.x + 30; // Checkbox 在验证框左边 30px
                                const clickY = box.y + (box.height / 2); // 垂直居中
                                await page.mouse.click(clickX, clickY);
                                console.log(`✅ 兜底物理坐标点击成功！坐标: (${clickX}, ${clickY})`);
                                altchaClicked = true;
                            }
                        }
                    } catch (e) {
                        console.error("❌ 坐标点击操作异常:", e.message);
                    }
                }

                await snap(page, `${user.username}_07_altcha_clicked`);

                // 轮询等待 ALTCHA 计算完成 (PoW 机制)
                console.log(">> 等待 ALTCHA PoW 计算验证通过...");
                let altchaPassed = false;
                for (let i = 0; i < 15; i++) {
                    const state = await page.evaluate(() => {
                        const widget = document.querySelector('altcha-widget');
                        if (widget) {
                            const stateAttr = widget.getAttribute('state') || widget.getAttribute('data-state');
                            if (stateAttr === 'verified' || stateAttr === 'solved' || stateAttr === 'success') {
                                return "verified";
                            }
                            if (widget.shadowRoot) {
                                const checkbox = widget.shadowRoot.querySelector('input[type="checkbox"]');
                                if (checkbox && checkbox.checked) {
                                    return "verified";
                                }
                            }
                        }
                        return "solving";
                    });

                    if (state === "verified") {
                        console.log("✅ ALTCHA 验证计算完成！");
                        altchaPassed = true;
                        break;
                    }
                    await delay(1000);
                }

                if (!altchaPassed) {
                    console.log("⚠️ ALTCHA 在 15 秒内未自动完成，强行尝试点击弹窗提交...");
                }

                // 点击弹窗中的 Renew 按钮
                console.log(">> 尝试点击弹窗中的 Renew 确认提交...");
                const clickedModalBtn = await page.evaluate(() => {
                    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .modal, .popup, div'));
                    for (let dialog of dialogs) {
                        if (dialog.querySelector('altcha-widget')) {
                            const buttons = Array.from(dialog.querySelectorAll('button'));
                            const renewBtn = buttons.find(b => b.textContent.trim().includes('Renew'));
                            if (renewBtn) {
                                renewBtn.click();
                                return "modal_renew_clicked";
                            }
                        }
                    }
                    return "not_found";
                });
                console.log(`>> Modal Renew 点击结果: ${clickedModalBtn}`);

                // 等待页面处理并重新载入
                await delay(5000);
                await snap(page, `${user.username}_08_after_renew_submit`);

                // 4. 获取续期后数据与警告信息
                warningMsg = await getWarningMessage(page);
                if (warningMsg) {
                    console.log(`🔴 检测到警告提示: ${warningMsg}`);
                }

                expiryAfter = await getExpiryDate(page);
                console.log(`>> 续期后到期时间为: ${expiryAfter || "未获取到日期"}`);

            } else {
                console.log("⚠️ 页面未发现 Renew 按钮，可能已被抢先占满或账号状态异常");
            }

            // 5. 结果逻辑比对
            const expiryBeforeDate = expiryBefore ? new Date(expiryBefore) : null;
            const expiryAfterDate = expiryAfter ? new Date(expiryAfter) : null;

            let isRenewed = false;
            let diffDays = 0;
            if (expiryBeforeDate && expiryAfterDate) {
                const diffTime = expiryAfterDate - expiryBeforeDate;
                diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                if (diffDays > 0) {
                    isRenewed = true;
                }
            }

            // 6. 构造 TG 消息格式
            let tgMsg = "";
            if (isRenewed) {
                tgMsg = `🎉 <b>Katabump 续期成功！</b>\n` +
                        `👤 用户: <code>${user.username}</code>\n` +
                        `📅 续期前到期日: <code>${expiryBefore || "未知"}</code>\n` +
                        `📅 续期后到期日: <code>${expiryAfter}</code>\n` +
                        `⏳ 延长天数: <b>${diffDays}</b> 天`;
            } else if (warningMsg) {
                tgMsg = `⚠️ <b>Katabump 未到续期</b>\n` +
                        `👤 用户: <code>${user.username}</code>\n` +
                        `📅 当前到期日: <code>${expiryBefore || "未知"}</code>\n` +
                        `🔴 页面提示: <i>${warningMsg}</i>`;
            } else {
                tgMsg = `⚠️ <b>Katabump 续期状态异常</b>\n` +
                        `👤 用户: <code>${user.username}</code>\n` +
                        `📅 到期时间未改变: <code>${expiryBefore || "未知"}</code>\n` +
                        `📝 请检查工作流截图确认是否卡在其他元素遮挡处。`;
            }

            console.log(">> 正在发送 Telegram 消息通知...");
            await sendTGMessage(tgMsg);

        } catch (err) {
            console.error(`❌ 处理用户 ${user.username} 时发生内部错误:`, err.message);
            if (page && !page.isClosed()) {
                await snap(page, `${user.username}_ERROR`);
            }
        } finally {
            if (page && !page.isClosed()) {
                await page.close().catch(() => {});
            }
        }
    }

    console.log(">> 所有用户任务执行完毕，正在释放浏览器会话。");
    await browser.close();
})();

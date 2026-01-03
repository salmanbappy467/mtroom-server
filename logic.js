const axios = require('axios');
const cheerio = require('cheerio');
const qs = require('querystring');

// ==========================================
// 1. AUTHENTICATION & LOGIN CHECK
// ==========================================

async function login(userId, password) {
    const url = 'http://www.rebpbs.com/login.aspx';
    try {
        const initialPage = await axios.get(url);
        const $ = cheerio.load(initialPage.data);
        const initialCookies = initialPage.headers['set-cookie'] || [];

        const payload = {
            '__VIEWSTATE': $('#__VIEWSTATE').val(),
            '__VIEWSTATEGENERATOR': $('#__VIEWSTATEGENERATOR').val(),
            '__EVENTVALIDATION': $('#__EVENTVALIDATION').val(),
            'txtusername': userId,
            'txtpassword': password,
            'btnLogin': decodeURIComponent('%E0%A6%B2%E0%A6%97%E0%A6%87%E0%A6%A8') 
        };

        const response = await axios.post(url, qs.stringify(payload), {
            headers: { 
                'Cookie': initialCookies.join('; '),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400
        });

        const authCookies = response.headers['set-cookie'] || [];
        return [...new Set([...initialCookies, ...authCookies])];
    } catch (error) {
        return null;
    }
}

async function verifyLoginDetails(userid, password) {
    try {
        const cookies = await login(userid, password);
        if (!cookies || cookies.length === 0) return { success: false, message: "Invalid Credentials" };

        const dashUrl = 'http://www.rebpbs.com/UI/OnM/frm_OCMeterTesterDashboard.aspx';
        const response = await axios.get(dashUrl, { headers: { 'Cookie': cookies.join('; ') } });
        const $ = cheerio.load(response.data);

        const pbsName = $('#ctl00_lblPBSname').text().trim();
        const userInfo = $('#ctl00_lblLoggedUser').text().trim();
        let zonalName = "Unknown Office";
        
        if (userInfo.includes(',')) {
            zonalName = userInfo.split(',').pop().replace(']', '').trim();
        }

        return { 
            success: true, 
            cookies: cookies,
            userInfo: userInfo,
            pbs: pbsName || "N/A", 
            zonal: zonalName 
        };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

// ==========================================
// 2. METER POSTING CORE FUNCTION
// ==========================================

const DEFAULTS = {
    payMode: '1', manfId: '581', phase: '1', type: 'j-39',
    volt: '240', mult: '1', zero: '0', sealTxt: 'LS'
};

async function postMeterData(cookies, m, options = {}) {
    const url = 'http://www.rebpbs.com/UI/Setup/meterinfo_setup.aspx';
    const session = axios.create({
        headers: { 
            'User-Agent': 'Mozilla/5.0',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookies.join('; '),
            'Referer': url
        },
        timeout: 30000 // 30s timeout
    });

    try {
        let newVS, newEV, pbs, zonal, gen;

        // 🔥 FAST MODE: If tokens are provided, SKIP Step 1 & 2
        if (options.viewState) {
            newVS = options.viewState;
            newEV = options.eventValidation;
            gen = options.viewStateGen;
            pbs = options.pbs;
            zonal = options.zonal;
        } else {
            // SLOW MODE: Fetch page explicitly (Step 1)
            const page = await session.get(url);
            const $ = cheerio.load(page.data);
            pbs = $('#ctl00_ContentPlaceHolder1_txtPBSName').val();
            zonal = $('#ctl00_ContentPlaceHolder1_txtZonalName').val();
            newVS = $('#__VIEWSTATE').val();
            newEV = $('#__EVENTVALIDATION').val();
            gen = $('#__VIEWSTATEGENERATOR').val();
        }

        if (!pbs) return { success: false, sessionExpired: true, reason: "Session Expired / Page Load Failed" };

        // Step 3: Final Submission (Direct)
        const savePayload = qs.stringify({
            '__EVENTTARGET': '', '__EVENTARGUMENT': '', '__VIEWSTATEENCRYPTED': '',
            '__VIEWSTATE': newVS, '__VIEWSTATEGENERATOR': gen, '__EVENTVALIDATION': newEV,
            'ctl00$ContentPlaceHolder1$txtPBSName': pbs,
            'ctl00$ContentPlaceHolder1$txtZonalName': zonal,
            'ctl00$ContentPlaceHolder1$ddlMeterPaymentMode': String(m.paymentMode || DEFAULTS.payMode),
            'ctl00$ContentPlaceHolder1$ddlMANUFACTUREname': String(m.manufacturerId || DEFAULTS.manfId),
            'ctl00$ContentPlaceHolder1$ddlPhase': String(m.phase || DEFAULTS.phase),
            'ctl00$ContentPlaceHolder1$txtMETER_NO': String(m.meterNo),
            'ctl00$ContentPlaceHolder1$txtSEAL_NO': String(m.sealNo),
            'ctl00$ContentPlaceHolder1$txtBULK_METER_NO': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtMETER_TYPE': m.meterType || DEFAULTS.type,
            'ctl00$ContentPlaceHolder1$txtVOLT': String(m.volt || DEFAULTS.volt),
            'ctl00$ContentPlaceHolder1$txtMULTIPLIER': DEFAULTS.mult,
            'ctl00$ContentPlaceHolder1$txtINITIAL_READING': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtDEMAND_READING': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtKWH_READING': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtCT_DATA_MANUFACTURER': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtCT_SERIAL_NO': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtCT_RATIO': DEFAULTS.mult,
            'ctl00$ContentPlaceHolder1$txtCT_SEAL_NO': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtPT_DATA_MANUFACTURER': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtPT_SERIAL_NO': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtPT_RATIO': DEFAULTS.mult,
            'ctl00$ContentPlaceHolder1$txtPT_SEAL_NO': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtPT_MULTIPLYING_FACTOR': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtBODY_SEAL': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtTERMINAL': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtBODY_SEAL1': DEFAULTS.sealTxt,
            'ctl00$ContentPlaceHolder1$txtTERMINAL2': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtBODY_SEAL2': DEFAULTS.sealTxt,
            'ctl00$ContentPlaceHolder1$txtBODY_SEAL3': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$ddlQMeterPaymentMode': '1',
            'ctl00$ContentPlaceHolder1$txtSearch': '',
            'ctl00$ContentPlaceHolder1$btSave': decodeURIComponent('%E0%A6%B8%E0%A6%82%E0%A6%B0%E0%A6%95%E0%A7%8D%E0%A6%B7%E0%A6%A3%20%E0%A6%95%E0%A6%B0%E0%A7%81%E0%A6%A8')
        });

        const finalRes = await session.post(url, savePayload);
        const $res = cheerio.load(finalRes.data);
        const lblMsg = $res('#ctl00_ContentPlaceHolder1_lblMsg').text().trim();

        const isSuccess = finalRes.data.includes('Successful') || finalRes.data.includes('Action was Successful');
        const isDuplicate = finalRes.data.includes('Already Exists') || 
                            finalRes.data.includes('Duplicate') || 
                            lblMsg.includes('Already Exists') || 
                            lblMsg.includes('exists');

        let reason = isSuccess ? "Saved Successfully" : (isDuplicate ? "Duplicate Meter" : (lblMsg || "Server Rejected"));

        return { success: isSuccess, reason: reason, isDuplicate };
    } catch (e) { return { success: false, reason: e.message }; }
}

// ==========================================
// 3. INVENTORY & VERIFICATION
// ==========================================

async function getInventoryList(cookies, limit = 50) {
    const url = 'http://www.rebpbs.com/UI/OfficeAutomation/Monitoring/EngineeringAndMaintenance/frmMeterInventoryMonitoring.aspx';
    const session = axios.create({ headers: { 'Cookie': cookies.join('; ') } });
    let allMeters = [];
    let currentPage = 1;

    try {
        const res = await session.get(url);
        let $ = cheerio.load(res.data);
        allMeters = parseTable($);

        while (allMeters.length < limit) {
            currentPage++;
            const payload = {
                '__EVENTTARGET': 'ctl00$ContentPlaceHolder1$gvMeterLOG',
                '__EVENTARGUMENT': `Page$${currentPage}`,
                '__VIEWSTATE': $('#__VIEWSTATE').val(),
                '__EVENTVALIDATION': $('#__EVENTVALIDATION').val(),
                '__VIEWSTATEGENERATOR': $('#__VIEWSTATEGENERATOR').val()
            };
            const nextRes = await session.post(url, qs.stringify(payload));
            $ = cheerio.load(nextRes.data);
            const newMeters = parseTable($);
            if (newMeters.length === 0) break;
            allMeters = allMeters.concat(newMeters);
        }
        return allMeters.slice(0, limit);
    } catch (e) { return allMeters; }
}

function parseTable($) {
    const list = [];
    $('#ctl00_ContentPlaceHolder1_gvMeterLOG tr').each((i, el) => {
        if (i === 0) return;
        const cols = $(el).children('td');
        if (cols.length >= 9) {
            const mNo = $(cols[1]).text().trim();
            if (mNo.length > 3) { // Filter out page numbers
                list.push({ 
                    brand: $(cols[0]).text().trim(), 
                    meterNo: mNo, 
                    status: $(cols[2]).text().trim(), 
                    cmo: $(cols[5]).text().trim().replace(/&nbsp;/g, '') || "N/A", 
                    seal: $(cols[6]).text().trim(), 
                    date: $(cols[8]).text().trim() 
                });
            }
        }
    });
    return list;
}

async function verifyMeter(cookies, meterNo) {
    const url = 'http://www.rebpbs.com/UI/OfficeAutomation/Monitoring/EngineeringAndMaintenance/frmMeterInventoryMonitoring.aspx';
    try {
        const session = axios.create({ headers: { 'Cookie': cookies.join('; ') } });
        const page = await session.get(url);
        const $ = cheerio.load(page.data);

        const payload = {
            '__VIEWSTATE': $('#__VIEWSTATE').val(), '__VIEWSTATEGENERATOR': $('#__VIEWSTATEGENERATOR').val(),
            '__EVENTVALIDATION': $('#__EVENTVALIDATION').val(),
            'ctl00$ContentPlaceHolder1$txtMeterNo': meterNo,
            'ctl00$ContentPlaceHolder1$Button1': 'Search', 'ctl00$ContentPlaceHolder1$rbApprove': '1'
        };

        const searchRes = await session.post(url, qs.stringify(payload));
        const $s = cheerio.load(searchRes.data);
        const row = $s('#ctl00_ContentPlaceHolder1_gvMeterLOG tr').eq(1);
        
        if (row.length > 0) {
            const cols = row.find('td');
            return {
                found: true,
                data: {
                    brand: $(cols[0]).text().trim(), meterNo: $(cols[1]).text().trim(),
                    status: $(cols[2]).text().trim(), cmo: $(cols[5]).text().trim().replace(/&nbsp;/g, '') || "N/A",
                    date: $(cols[8]).text().trim()
                }
            };
        }
        return { found: false };
    } catch (e) { return { found: false }; }
}

// ==========================================
// 4. BATCH PROCESSOR (SEQUENTIAL)
// ==========================================

async function processBatch(userid, password, meters, onProgress) {
    let auth = await verifyLoginDetails(userid, password);
    if (!auth.success) return { status: "error", message: auth.message };

    const postResults = [];
    let failedCount = 0;

    // 1. Posting Loop
    for (let i = 0; i < meters.length; i++) {
        const m = meters[i];

        // 🟢 PROGRESS UPDATE CALL
        if (onProgress) {
            onProgress({
                current: i + 1,
                total: meters.length,
                lastMeter: m.meterNo,
                status: "uploading"
            });
        }

        let postRes = await postMeterData(auth.cookies, m);
        if (!postRes.success && !postRes.isDuplicate) failedCount++;
        postResults.push({ original: m, result: postRes });
        
        // Realistic Delay (1.5s) to avoid bot detection and allow server processing
        await new Promise(r => setTimeout(r, 1500)); 
    }

    // 2. Wait for server update
    if(onProgress) onProgress({ current: meters.length, total: meters.length, lastMeter: "Verifying...", status: "verifying" });
    await new Promise(r => setTimeout(r, 2000));

    // 3. Bulk Fetch Inventory (Verification)
    const fetchLimit = meters.length + 20; 
    const inventoryList = await getInventoryList(auth.cookies, fetchLimit);

    // 4. Merge Results
    const finalOutput = postResults.map(item => {
        const liveData = inventoryList.find(inv => 
            inv.meterNo.toLowerCase() === item.original.meterNo.toLowerCase()
        );

        return {
            manufacturer: liveData ? liveData.brand : "N/A",
            meterNo: item.original.meterNo,
            sealNo: item.original.sealNo,
            postStatus: item.result.success ? "SUCCESS" : "FAILED",
            isDuplicate: item.result.isDuplicate || false,
            serverError: item.result.reason,
            liveStatus: liveData ? liveData.status : "Not Verified",
            cmo: liveData ? liveData.cmo : "N/A",
            date: liveData ? liveData.date : "N/A"
        };
    });

    return { 
        status: "completed", 
        count: meters.length, 
        failed: failedCount, 
        data: finalOutput 
    };
}

// ==========================================
// 5. CONCURRENT PROCESSOR (FAST / PARALLEL)
// ==========================================

async function fetchPageTokens(cookies) {
    const url = 'http://www.rebpbs.com/UI/Setup/meterinfo_setup.aspx';
    try {
        const session = axios.create({ headers: { 'Cookie': cookies.join('; ') }, timeout: 30000 });
        const response = await session.get(url);
        const $ = cheerio.load(response.data);
        return {
            viewState: $('#__VIEWSTATE').val(),
            eventValidation: $('#__EVENTVALIDATION').val(),
            viewStateGen: $('#__VIEWSTATEGENERATOR').val(),
            pbs: $('#ctl00_ContentPlaceHolder1_txtPBSName').val(),
            zonal: $('#ctl00_ContentPlaceHolder1_txtZonalName').val(),
            success: true
        };
    } catch (e) { return { success: false }; }
}

async function processConcurrentBatch(userid, password, meters, onProgress) {
    // 1. Verify Login
    let auth = await verifyLoginDetails(userid, password);
    if (!auth.success) return { status: "error", message: auth.message };

    // 2. Fetch Tokens ONCE
    const tokens = await fetchPageTokens(auth.cookies);
    if (!tokens.success || !tokens.viewState) {
        return { status: "error", message: "Failed to fetch initial page tokens" };
    }

    let results = [];
    const CHUNK_SIZE = 5; // Safe concurrency limit
    let processedCount = 0;

    // 3. Process in Chunks
    for (let i = 0; i < meters.length; i += CHUNK_SIZE) {
        const chunk = meters.slice(i, i + CHUNK_SIZE);
        
        // Map chunk to promises
        const chunkPromises = chunk.map(async (m) => {
            try {
                let result = await postMeterData(auth.cookies, m, tokens);
                
                // 🟢 Per-item Progress Update (within chunk)
                processedCount++;
                if (onProgress) {
                    onProgress({
                        current: processedCount,
                        total: meters.length,
                        lastMeter: m.meterNo,
                        status: "fast-uploading"
                    });
                }

                return {
                    meterNo: m.meterNo,
                    sealNo: m.sealNo,
                    postStatus: result.success ? "SUCCESS" : "FAILED",
                    reason: result.reason,
                    isDuplicate: result.isDuplicate || false
                };
            } catch (error) {
                return {
                    meterNo: m.meterNo,
                    sealNo: m.sealNo,
                    postStatus: "FAILED",
                    reason: "Network Error",
                    isDuplicate: false
                };
            }
        });

        // Wait for chunk
        const chunkResults = await Promise.all(chunkPromises);
        results = results.concat(chunkResults);

        // Small delay between chunks to be nice to the server
        await new Promise(r => setTimeout(r, 1000));
    }

    // 4. Calculate Stats
    const failedCount = results.filter(r => r.postStatus === "FAILED" && !r.isDuplicate).length;

    return { 
        status: "completed_chunked", 
        mode: "Smart Parallel (Chunked)",
        count: meters.length, 
        failed: failedCount, 
        data: results 
    };
}

// ==========================================
// EXPORT ALL FUNCTIONS
// ==========================================
module.exports = {
    verifyLoginDetails,
    postMeterData,
    getInventoryList,
    verifyMeter,
    processBatch,
    processConcurrentBatch
};
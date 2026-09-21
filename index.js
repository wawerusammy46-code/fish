const express = require('express');
const axios = require('axios');
const moment = require('moment');
const cors = require('cors');

// Safely load dotenv in local environments without breaking Railway production builds
try {
    require('dotenv').config();
} catch (e) {
    // dotenv is not installed in production; variables are injected by Railway
}

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Standard headers to bypass Safaricom Incapsula WAF blocks
const standardHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json'
};

// In-memory store for callback responses (for testing & polling)
const transactionStore = new Map();

/**
 * Middleware: Generate Daraja OAuth Token
 */
const generateToken = async (req, res, next) => {
    const consumerKey = process.env.CONSUMER_KEY;
    const consumerSecret = process.env.CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret) {
        return res.status(500).json({ error: 'CONSUMER_KEY or CONSUMER_SECRET is missing from environment variables.' });
    }

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    try {
        const response = await axios.get(
            'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
            {
                headers: {
                    Authorization: `Basic ${auth}`,
                    ...standardHeaders
                }
            }
        );

        req.token = response.data.access_token;
        next();
    } catch (error) {
        const errorData = error.response ? error.response.data : error.message;
        console.error('OAuth Token Error:', errorData);
        return res.status(500).json({
            message: 'Failed to generate Daraja OAuth token.',
            error: errorData
        });
    }
};

// Health Check Route
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'Online',
        message: 'M-Pesa Express Server is running smoothly.',
        timestamp: new Date().toISOString()
    });
});

/**
 * Route: Initiate STK Push
 * Body: { "amount": "1", "phoneNumber": "07XXXXXXXX", "accountReference": "Order #123" }
 */
app.post('/stkpush', generateToken, async (req, res) => {
    let { amount, phoneNumber, phone, accountReference } = req.body;

    let rawPhone = phoneNumber || phone;
    if (!rawPhone) {
        return res.status(400).json({ error: 'Phone number is required.' });
    }

    if (!amount || isNaN(amount) || Number(amount) <= 0) {
        return res.status(400).json({ error: 'Valid positive payment amount is required.' });
    }

    // Format phone number to 254XXXXXXXXX
    let formattedPhone = rawPhone.toString().trim().replace(/[^0-9]/g, '');
    if (formattedPhone.startsWith('0')) {
        formattedPhone = '254' + formattedPhone.slice(1);
    } else if (formattedPhone.startsWith('254') && formattedPhone.length === 12) {
        // Already valid format
    } else {
        return res.status(400).json({ error: 'Invalid Kenyan phone number format. Use 07XXXXXXXX or 2547XXXXXXXX.' });
    }

    const businessShortCode = process.env.BUSINESS_SHORT_CODE;
    const passkey = process.env.PASSKEY;

    if (!businessShortCode || !passkey) {
        return res.status(500).json({ error: 'BUSINESS_SHORT_CODE or PASSKEY is missing in environment variables.' });
    }

    // Format APP_URL into clean HTTPS domain
    let rawAppUrl = (process.env.APP_URL || '').trim();
    if (!rawAppUrl) {
        return res.status(500).json({ error: 'APP_URL environment variable is not defined.' });
    }

    let cleanDomain = rawAppUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const callbackUrl = `https://${cleanDomain}/callback`;

    const timestamp = moment().format('YYYYMMDDHHmmss');
    const password = Buffer.from(businessShortCode + passkey + timestamp).toString('base64');

    try {
        const response = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            {
                BusinessShortCode: businessShortCode,
                Password: password,
                Timestamp: timestamp,
                TransactionType: "CustomerPayBillOnline",
                Amount: Math.round(Number(amount)),
                PartyA: formattedPhone,
                PartyB: businessShortCode,
                PhoneNumber: formattedPhone,
                CallBackURL: callbackUrl,
                AccountReference: accountReference || "Payment",
                TransactionDesc: "M-Pesa Checkout"
            },
            {
                headers: {
                    Authorization: `Bearer ${req.token}`,
                    ...standardHeaders
                }
            }
        );

        console.log(`STK Push initiated successfully for ${formattedPhone}. CheckoutRequestID: ${response.data.CheckoutRequestID}`);
        res.status(200).json(response.data);
    } catch (error) {
        const errorData = error.response ? error.response.data : error.message;
        console.error('STK Push Error:', errorData);
        res.status(500).json({
            error: 'STK Push Request Failed',
            details: errorData
        });
    }
});

/**
 * Route: Query STK Push Status
 * Body: { "checkoutRequestId": "ws_CO_123456789..." }
 */
app.post('/stkquery', generateToken, async (req, res) => {
    const { checkoutRequestId } = req.body;

    if (!checkoutRequestId) {
        return res.status(400).json({ error: 'checkoutRequestId is required.' });
    }

    const businessShortCode = process.env.BUSINESS_SHORT_CODE;
    const passkey = process.env.PASSKEY;

    const timestamp = moment().format('YYYYMMDDHHmmss');
    const password = Buffer.from(businessShortCode + passkey + timestamp).toString('base64');

    try {
        const response = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query',
            {
                BusinessShortCode: businessShortCode,
                Password: password,
                Timestamp: timestamp,
                CheckoutRequestID: checkoutRequestId
            },
            {
                headers: {
                    Authorization: `Bearer ${req.token}`,
                    ...standardHeaders
                }
            }
        );

        res.status(200).json(response.data);
    } catch (error) {
        const errorData = error.response ? error.response.data : error.message;
        console.error('STK Query Error:', errorData);
        res.status(500).json({
            error: 'STK Query Failed',
            details: errorData
        });
    }
});

/**
 * Route: Daraja Instant Payment Notification Callback
 */
app.post('/callback', (req, res) => {
    console.log('--- M-Pesa Callback Received ---');
    console.log(JSON.stringify(req.body, null, 2));

    try {
        const stkCallback = req.body.Body?.stkCallback;
        if (stkCallback) {
            const checkoutRequestId = stkCallback.CheckoutRequestID;
            const resultCode = stkCallback.ResultCode;
            const resultDesc = stkCallback.ResultDesc;

            // Store transaction result in memory
            transactionStore.set(checkoutRequestId, {
                resultCode,
                resultDesc,
                callbackData: stkCallback,
                receivedAt: new Date().toISOString()
            });
        }
    } catch (e) {
        console.error('Error processing callback body:', e.message);
    }

    // Always respond with success to Safaricom Daraja
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

/**
 * Route: Get Polled Transaction Status from Callback Store
 */
app.get('/transaction-status/:checkoutRequestId', (req, res) => {
    const { checkoutRequestId } = req.params;
    const data = transactionStore.get(checkoutRequestId);

    if (!data) {
        return res.status(404).json({ status: 'Pending', message: 'Transaction callback not yet received.' });
    }

    res.status(200).json({ status: 'Completed', data });
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
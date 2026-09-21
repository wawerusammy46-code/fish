const express = require('express');
const axios = require('axios');
const moment = require('moment');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Middleware to generate Daraja OAuth Token
const generateToken = async (req, res, next) => {
    const consumerKey = process.env.CONSUMER_KEY;
    const consumerSecret = process.env.CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret) {
        return res.status(500).json({ error: 'Consumer Key or Consumer Secret is missing from environment variables.' });
    }

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    try {
        const response = await axios.get(
            'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
            {
                headers: {
                    Authorization: `Basic ${auth}`,
                    // Custom headers to prevent Incapsula WAF blocking
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            }
        );

        req.token = response.data.access_token;
        next();
    } catch (error) {
        console.error('OAuth Token Error:', error.response ? error.response.data : error.message);
        return res.status(500).json({
            message: 'OAuth Token Error',
            error: error.response ? error.response.data : error.message
        });
    }
};

// Root / Health Check Route
app.get('/', (req, res) => {
    res.send('M-Pesa Express Server is running!');
});

// STK Push Route
app.post('/stkpush', generateToken, async (req, res) => {
    const { amount, phoneNumber } = req.body;

    const businessShortCode = process.env.BUSINESS_SHORT_CODE;
    const passkey = process.env.PASSKEY;
    const appUrl = process.env.APP_URL;

    if (!businessShortCode || !passkey || !appUrl) {
        return res.status(500).json({ error: 'Missing configuration variables (BUSINESS_SHORT_CODE, PASSKEY, or APP_URL).' });
    }

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
                Amount: amount,
                PartyA: phoneNumber,
                PartyB: businessShortCode,
                PhoneNumber: phoneNumber,
                CallBackURL: `${appUrl}/callback`,
                AccountReference: "Pick and Drop",
                TransactionDesc: "Logistics Payment"
            },
            {
                headers: {
                    Authorization: `Bearer ${req.token}`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            }
        );

        res.status(200).json(response.data);
    } catch (error) {
        console.error('STK Push Error:', error.response ? error.response.data : error.message);
        res.status(500).json(error.response ? error.response.data : { error: error.message });
    }
});

// Daraja Callback Route
app.post('/callback', (req, res) => {
    console.log('--- M-Pesa Callback Received ---');
    console.log(JSON.stringify(req.body, null, 2));

    const callbackData = req.body.Body.stkCallback;

    if (callbackData.ResultCode === 0) {
        console.log('Payment Successful!');
        // Process successful payment logic here
    } else {
        console.log(`Payment Failed: ${callbackData.ResultDesc}`);
    }

    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
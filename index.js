const express = require('express');
const axios = require('axios');
const moment = require('moment');

const app = express();
app.use(express.json());

// Pull credentials from environment variables
const businessShortCode = process.env.BUSINESS_SHORT_CODE;
const passkey = process.env.PASSKEY;
const consumerKey = process.env.CONSUMER_KEY;
const consumerSecret = process.env.CONSUMER_SECRET;

// Middleware to generate Daraja OAuth Token
const generateToken = async (req, res, next) => {
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  try {
    const response = await axios.get(
      'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );
    req.token = response.data.access_token;
    next();
  } catch (error) {
    console.error('OAuth Token Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to generate access token' });
  }
};

// Health check endpoint
app.get('/', (req, res) => {
  res.send('M-Pesa Express Server is running!');
});

// STK Push endpoint
app.post('/stkpush', generateToken, async (req, res) => {
  const { amount, phoneNumber } = req.body;
  const timestamp = moment().format('YYYYMMDDHHmmss');
  const password = Buffer.from(businessShortCode + passkey + timestamp).toString('base64');

  try {
    const response = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: businessShortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phoneNumber,
        PartyB: businessShortCode,
        PhoneNumber: phoneNumber,
        CallBackURL: `${process.env.APP_URL}/callback`,
        AccountReference: 'AP Canteen',
        TransactionDesc: 'Food Order',
      },
      { headers: { Authorization: `Bearer ${req.token}` } }
    );
    res.status(200).json(response.data);
  } catch (error) {
    console.error('STK Push Error:', error.response?.data || error.message);
    res.status(500).json(error.response?.data || { error: 'STK push failed' });
  }
});

// M-Pesa Callback endpoint
app.post('/callback', (req, res) => {
  console.log('M-Pesa Callback Data:', JSON.stringify(req.body, null, 2));
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// Dynamic Port for Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
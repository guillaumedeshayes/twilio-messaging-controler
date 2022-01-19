// GENERAL IMPORTS
// ---------------
// Libraries
const CryptoJS = require("crypto-js");
const jwt = require('jsonwebtoken');
const CustomersRepo = require('../repos/customers-repo');
const DynamicQueryRepo = require('../repos/dynamic-query-repo');
// Database and Tables
const db = require('../../orm/models/index');
const { Op } = require('sequelize');
const Brands = db.brands;
const SocialMedias = db.brand_social_medias;
const Stores = db.stores;
const LoyaltyConfigs = db.loyalty_configurations;
const LoyaltyUnits = db.loyalty_units;
const LoyaltyCoefficients = db.loyalty_coefficients;
const Products = db.products;
const ProductAvailabilities = db.product_availabilities
const ProductImages = db.product_images;
const RewardProducts = db.reward_products;
const RewardDiscounts = db.reward_discounts;
const Customers = db.customers;
const Visits = db.visits;
const UnitTransactions = db.unit_transactions;
const LoyaltyLogs = db.loyalty_logs;
const BrandStyles = db.brand_styles;
const BrandColors = db.brand_colors;
const BrandFonts = db.brand_fonts;
const BrandAnalytics = db.brand_analytics;
const CustomerVerifications = db.customer_verifications;
const LoyaltyRewards = db.loyalty_rewards;
const BrandAnalyticsIds = db.brand_analyticsids;

// TWILIO VERIFICATION: to verify a customer's phone number before he/she could claim a reward
// -------------------
// Twilio connection
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const verifySid = process.env.TWILIO_VERIFY_SID;
const client = require('twilio')(accountSid, authToken, {
  logLevel: 'debug'
});
// Middlewares
exports.sendVerificationToken = async (req, res) => {
    // POST request to send verification code to customer
    try {
        var phoneToReach = req.query.customer.phone;
            client.verify.services(verifySid)
                .verifications
                .create({to: phoneToReach, channel: 'sms', locale: 'fr'})
                .then(verification => {
                    res.status(200).json(verification);
                });
    } catch (error) {
        console.log('ERR sendVerificationToken:', err);
        res.status(500).json(err);
    }
}
exports.checkVerificationToken = async (req, res) => {
    // POST request to verify the input from the customer
    try {
        const phoneToReach = req.query.customer.phone;
        const code = req.body.code
        client.verify.services(verifySid)
            .verificationChecks
            .create({to: phoneToReach, code: code})
            .then(async (verification_check) => {
                const [custVerif, created] = await CustomerVerifications.findOrCreate({where: {customerId:req.query.customer.id}, defaults: {customerId:req.query.customer.id}});
                if (verification_check.status == "approved" && verification_check.valid == true) {
                    await CustomerVerifications.update({phone: true}, {where: {id: custVerif.id}});
                }
                res.status(200).json(verification_check);
            })
            .catch(err => {
                res.status(500).json(err);
            })
    } catch (err) {
        console.log('ERR checkVerificationToken:', err);
        res.status(500).json(err);
    }   
}
exports.checkPhoneVerification = async (req, res) => {
    // GET request to check if customer got verified in a time period of 3 months, verify phone number again if not
    try {
        var verif = await CustomerVerifications.findOne({
            where: {
                customerId: req.query.customer.id,
                phone: true
            },
        })
        // If verification > 3 months, update to Phone = false
        const lastPhoneVerifDate = new Date(verif.updatedAt);
        const today = new Date();
        const dateInterval = today.getTime() - lastPhoneVerifDate.getTime()
        if ((dateInterval < 0) || (dateInterval > 1000*3600*24*30*3)) {
            verif.phone = false;
            await CustomerVerifications.update({phone: false}, {where: {customerId: req.query.customer.id}})
        }
        res.status(200).json(verif)       
    } catch (err) {
        console.log('ERR checkPhoneVerification:', err);
        res.status(404).json(err);
    }
}

// TWILIO CAMPAIGNS
// ----------------
function formatCampaignBody({campaign, target}) {
    // POST request to format a message (send from our SaaS frontend by marketing teams)
    var text = campaign.body
    if (text.includes('{{')) {
        var splitted = text.split('{{')
        for (let i = 1; i < splitted.length; i++) {
            var el = splitted[i];
            const variableNameToDisplay = el.split('}}')[0]
            const variableValue = target[variableNameToDisplay] || '';
            var newSplittedI = el.split('}}');
            newSplittedI.splice(0, 1, variableValue);
            newSplittedI = newSplittedI.join('');
            splitted.splice(i, 1, newSplittedI);
        }
        text = splitted.join('');
    }
    return text
}
exports.createSmsCampaign = async (req, res) => {
    // POST request to send a messaging campaign from our SaaS frontend
    try {
        const newCampaign = await SMSCampaigns.create(req.body.campaign);
        const targets = req.body.targets;
        var smsMessagesList = [];
        for (let target of targets) {
            TwilioClient.messages
                .create({
                    body: formatCampaignBody({campaign: newCampaign, target: target}),
                    from: '+33757590404',
                    statusCallback: (process.env.NODE_ENV !== 'development') ? `${process.env.VIRTUAL_HOST}/sms/twilio/statusCallback/${newCampaign.id}/${target.id}` : undefined,
                    to: target.phone,
                })
                .then(async (message) => {
                    var smsToCreate = {
                        campaignId: newCampaign.id,
                        customerId: target.id,
                        ...message,
                    };
                    const newSMS = await SMSMessages.create(smsToCreate);
                    smsMessagesList.push({
                        ...newSMS.dataValues,
                        customer: target
                    });
                })
                .done();
        };
        const newCampaignBrand = await Brands.findOne({where:{id:req.params.brandId}});
        res.status(201).json({message: 'Sms campaign successfully sent', campaign: {...newCampaign.dataValues, brand: newCampaignBrand, sms_messages: smsMessagesList}});
    } catch(err) {
        console.log('ERR createSMSCampaign:', err);
        res.status(400).json(err);
    }
}
exports.readAllSmsCampaigns = async (req, res) => {
    // GET request to fetch SMS campaigns sent by our client from our database
    try {
        const campaigns = await SMSCampaigns.findAll({
            where: {
                brandId: {
                    [Op.in]: req.query.viewAuth.brands // authorizing only brands the user can view
                }
            },
            include: [{
                model: SMSMessages,
                include: {model: Customers}
            }, {
                model: Brands
            }]
        })
        res.status(200).json(campaigns)       
    } catch (err) {
        console.log('ERR readAllSMSCampaigns:', err);
        res.status(404).json(err);        
    }
}
exports.updateSmsStatusFromTwilio = async (req, res) => {
    // POST request to Twilio API to update SMS status (sent, opened, clicked...)
    try {
        const messageToUpdate = await SMSMessages.findOne({where: { campaignId: req.params.campaignId, customerId: req.params.customerId, sid: req.body.MessageSid}});
        if (!messageToUpdate.price) {
            TwilioClient.messages(req.body.MessageSid)
                .fetch()
                .then(async (message) => {
                    await SMSMessages.update({status: req.body.MessageStatus, price: message.price}, {where: { campaignId: req.params.campaignId, customerId: req.params.customerId, sid: req.body.MessageSid}});
                    res.status(200).json('Successfully updated');
                })
        } else {
            await SMSMessages.update({status: req.body.MessageStatus}, {where: { campaignId: req.params.campaignId, customerId: req.params.customerId, sid: req.body.MessageSid}});
            res.status(200).json('Successfully updated');
        }
    } catch (err) {
        console.log('ERR updateSMSMessagestatusFromTwilio:', err);
        res.status(404).json(err);
    }
}

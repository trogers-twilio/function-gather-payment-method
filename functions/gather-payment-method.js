const Twilio = require('twilio');
const cardValid = require('card-validator');

// Card type list is from 'credit-card-type' repo, used by 'card-validator'
// https://github.com/braintree/credit-card-type
const cardTypes = {
  visa: 'visa',
  mastercard: 'mastercard',
  americanExpress: 'american-express',
  dinersClub: 'diners-club',
  discover: 'discover',
  jcb: 'jcb',
  unionPay: 'unionpay',
  maestro: 'maestro',
  mir: 'mir',
  elo: 'elo',
  hiper: 'hiper',
  hipercard: 'hipercard',
};
const steps = {
  start: 'start',
  verifyCard: 'verifyCard',
  confirmEntry: 'confirmEntry',
  gatherExpiration: 'gatherExpiration',
  verifyExpiration: 'verifyExpiration',
  gatherSecurityCode: 'gatherSecurityCode',
  verifySecurityCode: 'verifySecurityCode',
  gatherZipCode: 'gatherZipCode',
  verifyZipCode: 'verifyZipCode',
  processPayment: 'processPayment',
};

let runtimeFunction;
let studioWebhook;
let callSid;
let isSyncMapCreated;

const getSyncMap = (syncMapClient, syncMapName) => new Promise(async (resolve) => {
  try {
    const syncMap = await syncMapClient.fetch();
    if (syncMap.uniqueName === syncMapName) {
      resolve(syncMap);
    } else {
      resolve(undefined);
    }
    return;
  } catch (error) {
    console.error('Failed to retrieve sync map.', error);
    resolve(undefined);
  }
});

const generateActionUrl = ({ step, prevStep, nextStep, retryStep } = {}) => {
  const actionUrl = `${runtimeFunction}?studioWebhook=${studioWebhook}&`
    + `isSyncMapCreated=${isSyncMapCreated}&`
    + `${callSid ? `callSid=${callSid}&` : ''}`
    + `${step ? `step=${step}&` : ''}`
    + `${prevStep ? `prevStep=${prevStep}&` : ''}`
    + `${nextStep ? `nextStep=${nextStep}&` : ''}`
    + `${retryStep ? `retryStep=${retryStep}&` : ''}`;

  return actionUrl;
};

const splitCardNumber = (cardNumber, gaps) => {
  const numberBlocks = [];
  for (let i = 0; i <= gaps.length; i++) {
    if (i === 0) {
      numberBlocks.push(cardNumber.substring(0, gaps[i]));
    } else if (i === gaps.length) {
      numberBlocks.push(cardNumber.substring(gaps[i - 1]));
    } else {
      numberBlocks.push(cardNumber.substring(gaps[i - 1], gaps[i]));
    }
  }
  return numberBlocks;
};

const speakNumberBlocks = (say, numberBlocks) => {
  for (let i = 0; i < numberBlocks.length; i++) {
    const digits = numberBlocks[i];
    say.ssmlSayAs({ 'interpret-as': 'digits' }, digits);
    if (i < numberBlocks.length - 1) {
      say.ssmlBreak();
    }
  }
};

const checkExpirationDate = (expirationDate) => {
  const result = { isValid: false };
  if (!expirationDate) {
    result.reason = 'I did not understand your entry.';
    return result;
  }
  if (expirationDate.length < 4) {
    result.reason = 'Expiration date must be 4 digits.';
    return result;
  }
  const expirationMonth = parseInt(expirationDate.substring(0, 2), 10);
  if (expirationMonth < 1 || expirationMonth > 12) {
    result.reason = 'Expiration month must be a number between 1 and 12.';
    return result;
  }
  const expirationYear = `20${expirationDate.substring(2)}`;
  // TODO: Add check if expiration month and year is current month/year or greater
  result.isValid = true;
  result.fullDate = `${expirationYear}${expirationDate.substring(0, 2)}??`;
  return result;
};

const checkSecurityCode = (securityCode, securityCodeSize) => {
  const result = { isValid: false };
  if (securityCode.length < securityCodeSize) {
    result.reason = `Security code must be ${securityCodeSize} digits in length.`;
    return result;
  }
  result.isValid = true;
  return result;
};

// eslint-disable-next-line func-names
exports.handler = async function (context, event, callback) {
  console.log('Event:', event);
  console.log('Context:', context);

  ({ callSid, studioWebhook, isSyncMapCreated } = event);
  const { paymentAmount, step, prevStep, nextStep, retryStep } = event;
  console.log('Current step:', step);

  const client = context.getTwilioClient();

  const syncClient = client.sync.services(context.TWILIO_SYNC_SERVICES_SID);
  let syncMapName = 'FunctionsCache';
  let syncMapClient = syncClient.syncMaps(syncMapName);

  let callCache = {};
  if (!isSyncMapCreated) {
    console.log('Checking if sync map is created');
    isSyncMapCreated = !!await getSyncMap(syncMapClient, syncMapName);
  }
  if (isSyncMapCreated) {
    console.log('Fetching sync map item for call sid', callSid);
    try {
      callCache = await syncMapClient.syncMapItems(callSid).fetch();
    } catch (error) {
      if (error.status === 404) {
        console.log('No matching sync map item for call sid', callSid);
      } else {
        console.log('Failed to fetch sync map item.', error);
      }
    }
  } else {
    const syncMap = await syncClient.syncMaps.create({ uniqueName: syncMapName });
    console.log('Sync map created:', syncMap);
    isSyncMapCreated = true;
  }

  console.log(`${callCache ? `callCache for call sid ${callCache.key}: ${JSON.stringify(callCache.data)}` : ''}`);
  if (!callCache.key) {
    callCache = await syncMapClient.syncMapItems.create({
      ttl: 3600,
      key: callSid,
      data: { paymentAmount },
    });
    console.log('callCache created:', callCache);
  }

  runtimeFunction = `https://${context.DOMAIN_NAME}/gather-payment-method`;
  const studioRedirect = `${studioWebhook}?FlowEvent=audioComplete`;
  console.log('studioRedirect:', studioRedirect);
  const twiml = new Twilio.twiml.VoiceResponse();
  const gatherDefaults = {
    method: 'POST',
    input: 'dtmf',
    finishOnKey: '#',
    timeout: 5,
  };
  const sayDefaults = {
    voice: 'Polly.Salli',
  };
  const say = twiml.say(sayDefaults);

  switch (step) {
    case steps.start: {
      const gatherOptions = gatherDefaults;
      gatherOptions.action = generateActionUrl({
        step: steps.verifyCard,
        prevStep: step,
      });
      const gather = twiml.gather(gatherOptions);
      gather.say(sayDefaults, 'Please enter your credit card number, followed by the pound key');
      twiml.redirect(generateActionUrl({
        step: steps.start,
        prevStep: step,
      }));
      break;
    }
    case steps.verifyCard: {
      const cardNumber = event.Digits || callCache.data.cardNumber;
      const cardCheck = cardValid.number(cardNumber);
      console.log('Card check result:', cardCheck);

      if (cardCheck.isValid) {
        console.log('Updating call cache with card info');
        try {
          await callCache.update({ data: {
            ...callCache.data,
            cardNumber,
            cardType: cardCheck.card.type,
            securityCodeSize: cardCheck.card.code.size,
          } });
        } catch (error) {
          console.log('Failed to update call cache.', error);
        }

        say.addText('This is the verify card step. You entered,');
        const numberBlocks = splitCardNumber(cardNumber, cardCheck.card.gaps);
        speakNumberBlocks(say, numberBlocks);

        const gatherOptions = gatherDefaults;
        gatherOptions.action = generateActionUrl({
          step: steps.confirmEntry,
          prevStep: step,
          nextStep: steps.gatherExpiration,
          retryStep: steps.start,
        });
        gatherOptions.numDigits = 1;
        const gather = twiml.gather(gatherOptions);
        gather.say(sayDefaults, 'If this is correct, press 1. Otherwise press 2 to re enter your card number.');

        twiml.redirect(generateActionUrl({
          step: steps.verifyCard,
          prevStep: step,
        }));
      } else {
        say.addText('Card number is invalid. Please try again.');
        twiml.redirect(generateActionUrl({
          step: steps.start,
          prevStep: step,
        }));
      }
      break;
    }
    case steps.confirmEntry: {
      if (event.Digits === '1') {
        twiml.redirect(generateActionUrl({
          step: nextStep,
          prevStep: step,
        }));
      } else {
        twiml.redirect(generateActionUrl({
          step: retryStep,
          prevStep: step,
        }));
      }
      break;
    }
    case steps.gatherExpiration: {
      const gatherOptions = gatherDefaults;
      gatherOptions.action = generateActionUrl({
        step: steps.verifyExpiration,
        prevStep: step,
      });
      gatherOptions.numDigits = 4;
      const gather = twiml.gather(gatherOptions);
      gather.say(sayDefaults, 'Please enter the two digit month and two digit year'
        + "of your card's expiration date");
      twiml.redirect(generateActionUrl({
        step: steps.gatherExpiration,
        prevStep: step,
      }));
      break;
    }
    case steps.verifyExpiration: {
      const expiration = event.Digits || callCache.data.expiration;
      const expirationCheck = checkExpirationDate(expiration);
      console.log('Expiration check result:', expirationCheck);

      if (expirationCheck.isValid) {
        await callCache.update({ data: { ...callCache.data, expiration } });

        say.addText('This is the verify expiration step. You entered,');
        say.ssmlSayAs({ 'interpret-as': 'date' }, expirationCheck.fullDate);

        const gatherOptions = gatherDefaults;
        gatherOptions.action = generateActionUrl({
          step: steps.confirmEntry,
          prevStep: step,
          nextStep: steps.gatherSecurityCode,
          retryStep: steps.gatherExpiration,
        });
        gatherOptions.numDigits = 1;
        const gather = twiml.gather(gatherOptions);
        gather.say(sayDefaults, 'If this is correct, press 1. Otherwise press 2 to re enter your expiration date.');

        twiml.redirect(generateActionUrl({
          step: steps.verifyExpiration,
          prevStep: step,
        }));
      } else {
        say.addText(`${expirationCheck.reason} Please try again.`);
        twiml.redirect(generateActionUrl({
          step: steps.gatherExpiration,
          prevStep: step,
        }));
      }
      break;
    }
    case steps.gatherSecurityCode: {
      const gatherOptions = gatherDefaults;
      gatherOptions.action = generateActionUrl({
        step: steps.verifySecurityCode,
        prevStep: step,
      });
      gatherOptions.numDigits = callCache.data.securityCodeSize;
      let message = 'Please enter the security code. ';
      message += callCache.data.cardType === cardTypes.americanExpress
        ? 'This is the four digit number located just to the right of your credit card number.'
        : 'This is a three digit number located on the back of your card.';
      const gather = twiml.gather(gatherOptions);
      gather.say(sayDefaults, message);
      twiml.redirect(generateActionUrl({
        step: steps.gatherSecurityCode,
        prevStep: step,
      }));
      break;
    }
    case steps.verifySecurityCode: {
      const securityCode = event.Digits || callCache.data.securityCode;
      const securityCodeCheck = checkSecurityCode(securityCode, callCache.data.securityCodeSize);
      console.log('Security code check result:', securityCodeCheck);

      if (securityCodeCheck.isValid) {
        await callCache.update({ data: { ...callCache.data, securityCode } });

        say.addText('This is the verify security code step. You entered,');
        say.ssmlSayAs({ 'interpret-as': 'digits' }, securityCode);

        const gatherOptions = gatherDefaults;
        gatherOptions.action = generateActionUrl({
          step: steps.confirmEntry,
          prevStep: step,
          nextStep: steps.gatherZipCode,
          retryStep: steps.gatherSecurityCode,
        });
        gatherOptions.numDigits = 1;
        const gather = twiml.gather(gatherOptions);
        gather.say(sayDefaults, 'If this is correct, press 1. Otherwise press 2 to re enter your security code.');

        twiml.redirect(generateActionUrl({
          step: steps.verifyExpiration,
          prevStep: step,
        }));
      } else {
        say.addText(`${securityCodeCheck.reason} Please try again.`);
        twiml.redirect(generateActionUrl({
          step: steps.gatherExpiration,
          prevStep: step,
        }));
      }
      break;
    }
    case steps.gatherZipCode: {
      const gatherOptions = gatherDefaults;
      gatherOptions.action = generateActionUrl({
        step: steps.verifyZipCode,
        prevStep: step,
      });
      gatherOptions.numDigits = 5;
      const gather = twiml.gather(gatherOptions);
      gather.say(sayDefaults, 'Please enter your zip code.');
      twiml.redirect(generateActionUrl({
        step: steps.gatherZipCode,
        prevStep: step,
      }));
      break;
    }
    case steps.verifyZipCode: {
      const zipCode = event.Digits || callCache.data.zipCode;
      const isZipCodeValid = zipCode.length === 5;
      console.log('Zip code valid:', isZipCodeValid);

      if (isZipCodeValid) {
        await callCache.update({ data: { ...callCache.data, zipCode } });

        say.addText('This is the verify zip code step. You entered,');
        say.ssmlSayAs({ 'interpret-as': 'digits' }, zipCode);

        const gatherOptions = gatherDefaults;
        gatherOptions.action = generateActionUrl({
          step: steps.confirmEntry,
          prevStep: step,
          nextStep: steps.processPayment,
          retryStep: steps.gatherZipCode,
        });
        gatherOptions.numDigits = 1;
        const gather = twiml.gather(gatherOptions);
        gather.say(sayDefaults, 'If this is correct, press 1. Otherwise press 2 to re enter your security code.');

        twiml.redirect(generateActionUrl({
          step: steps.verifyZipCode,
          prevStep: step,
        }));
      } else {
        say.addText('Zip code must be five digits long. Please try again.');
        twiml.redirect(generateActionUrl({
          step: steps.gatherZipCode,
          prevStep: step,
        }));
      }
      break;
    }
    case steps.processPayment: {
      /* TODO: Add asynchronous processing so TwiML is returned right away while the
         payment is processed. When processing is complete, use TwiML redirect to
         send the call back to Studio. */
      say.addText('Please wait while your payment is processed.');

      syncMapName = 'PaymentResult';
      syncMapClient = syncClient.syncMaps(syncMapName);

      let paymentResult = {};

      console.log('Checking if sync map is created');
      isSyncMapCreated = !!await getSyncMap(syncMapClient, syncMapName);
      if (isSyncMapCreated) {
        try {
          paymentResult = await syncMapClient.syncMapItems(callSid).fetch();
        } catch (error) {
          if (error.status === 404) {
            console.log('Sync map item does not exist for call sid', callSid);
          } else {
            console.log('Failed to fetch sync map item.', error);
          }
        }
      } else {
        const syncMap = await syncClient.syncMaps.create({ uniqueName: syncMapName });
        console.log('Sync map created:', syncMap);
        isSyncMapCreated = true;
      }

      console.log(`${paymentResult ? `${paymentResult.key}: ${JSON.stringify(paymentResult.data)}` : ''}`);
      if (!paymentResult.key) {
        paymentResult = await syncMapClient.syncMapItems.create({
          ttl: 3600,
          key: callSid,
          data: { paymentAmount: callCache.data.paymentAmount },
        });
        console.log('paymentResult:', paymentResult);
      }

      // Perform payment processing here. Mock payment result included as a test.
      paymentResult = await paymentResult.update({ data: { success: true } });
      console.log('Final payment result:', paymentResult.data);

      console.log('Deleting call cache sync map item for call sid', callSid);
      await callCache.remove();
      console.log('Call cache deleted');

      twiml.redirect(studioRedirect);
      break;
    }
    default: {
      break;
    }
  }

  callback(null, twiml);
};

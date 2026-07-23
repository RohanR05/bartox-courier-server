const express = require("express");
const cors = require("cors");
const app = express();
const crypto = require("crypto");
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const stripe = require("stripe")(process.env.PAYMENT_SECURE);

app.use(express.json());
app.use(cors());

function generateTrackingId(prefix = "TRK") {
  // Generates an 8-character uppercase hex string
  const randomBytes = crypto.randomBytes(4).toString("hex").toUpperCase();
  const timestamp = Date.now().toString(36).toUpperCase().slice(-4); // Adds temporal uniqueness

  return `${prefix}-${timestamp}-${randomBytes}`;
}

console.log(generateTrackingId()); // e.g., TRK-LX89-A1B2C3D4

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.fxlcgfl.mongodb.net/?appName=Cluster0`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("batrox_courier");
    const parcelCollection = db.collection("parcels");
    const paymentCollestion = db.collection("payments");

    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;
      if (email) {
        query.senderEmail = email;
      }
      const options = { sort: { createdAt: -1 } };
      const cursor = parcelCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      const result = await parcelCollection.insertOne(parcel);
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.deleteOne(query);
      res.send(result);
    });

    app.post("/create-checkout-session", async (req, res) => {
      try {
        const paymentInfo = req.body;
        const amount = Math.round(parseFloat(paymentInfo.cost) * 100);

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                unit_amount: amount,
                product_data: {
                  name: paymentInfo.parcelTitle || "Parcel Delivery Fee",
                },
              },
              quantity: 1,
            },
          ],
          customer_email: paymentInfo.senderEmail,
          mode: "payment",
          metadata: {
            parcelId: paymentInfo.parcelId,
          },
          // Pass metadata down to the actual PaymentIntent so it shows up under Payments in the Dashboard
          payment_intent_data: {
            metadata: {
              parcelId: paymentInfo.parcelId,
            },
            description: `Parcel Delivery Fee for ${paymentInfo.parcelTitle || paymentInfo.parcelId}`,
          },
          success_url: `${process.env.SITE_DOMAIN}dashBoard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}dashBoard/payment-cancelled`,
        });

        // Log the generated ID so you can copy-paste search it in Stripe search bar
        console.log("👉 GENERATED SESSION ID:", session.id);

        res.send({ url: session.url });
      } catch (error) {
        console.error("Stripe Checkout Error:", error);
        res.status(500).send({ error: error.message });
      }
    });

    app.patch("/payment-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;

        if (!sessionId) {
          return res.status(400).send({
            success: false,
            message: "Missing session_id query parameter",
          });
        }

        // 1. Retrieve session from Stripe
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === "paid") {
          const id = session.metadata?.parcelId;

          if (!id || !ObjectId.isValid(id)) {
            return res.status(400).send({
              success: false,
              message: "Invalid or missing parcelId in metadata",
            });
          }

          const transactionId = session.payment_intent;

          // 2. Safely process payment atomically using upsert
          const paymentData = {
            amount: session.amount_total / 100,
            currency: session.currency,
            customer_email:
              session.customer_details?.email || session.customer_email,
            parcelId: id,
            transactionId: transactionId,
            paymentStatus: session.payment_status,
            paidAt: new Date(),
          };

          // upsert: true inserts ONLY if transactionId doesn't exist yet
          const paymentResult = await paymentCollestion.updateOne(
            { transactionId: transactionId },
            { $setOnInsert: paymentData },
            { upsert: true },
          );

          // 3. Handle tracking ID update
          let trackingId;
          const existingParcel = await parcelCollection.findOne({
            _id: new ObjectId(id),
          });

          if (existingParcel?.trackingId) {
            trackingId = existingParcel.trackingId;
          } else {
            trackingId = generateTrackingId();
            await parcelCollection.updateOne(
              { _id: new ObjectId(id) },
              {
                $set: {
                  paymentStatus: "paid",
                  trackingId: trackingId,
                },
              },
            );
          }

          return res.send({
            success: true,
            message:
              paymentResult.upsertedCount > 0
                ? "Payment recorded successfully"
                : "Payment already exists",
            trackingId: trackingId,
            transactionId: transactionId,
          });
        }

        return res.status(400).send({
          success: false,
          message: "Payment status is not paid",
        });
      } catch (error) {
        console.error("Error processing payment success:", error);
        return res.status(500).send({
          success: false,
          message: error.message || "Internal server error",
        });
      }
    });

    app.get("/payments", async (req, res) => {
      const email = req.query.email;
      const query = {};
      if (email) {
        query.customer_email = email;
      }
      const cursor = paymentCollestion.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Yeahhhhhhhhh, Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Batrox Courier server");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

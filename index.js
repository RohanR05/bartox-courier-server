const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const stripe = require("stripe")(process.env.PAYMENT_SECURE);

app.use(express.json());
app.use(cors());

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
        const amount = Math.round(parseFloat(paymentInfo.cost) * 100); // Math.round handles potential decimal amounts safely

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
          customer_email: paymentInfo.senderEmail, // Fixed: now passing actual email
          mode: "payment",
          metadata: {
            parcelId: paymentInfo.parcelId,
          },
          success_url: `${process.env.SITE_DOMAIN}dashBoard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}dashBoard/payment-cancelled`, // Fixed: changed cancelled_url -> cancel_url
        });

        res.send({ url: session.url });
      } catch (error) {
        console.error("Stripe Checkout Error:", error);
        res.status(500).send({ error: error.message });
      }
    });

    app.patch("/payment-success", (req, res) => {
      const sessionId = req.query.session_id;
      console.log(sessionId);
      res.send({ success: true });
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

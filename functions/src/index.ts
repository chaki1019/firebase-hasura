import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import ApolloClient from "apollo-boost";
import fetch from "node-fetch";
import gql from "graphql-tag";

admin.initializeApp();

const client = new ApolloClient({
  uri: functions.config().hasura.url,
  fetch: fetch as any,
  request: (operation): void => {
    operation.setContext({
      headers: {
        "x-hasura-admin-secret": functions.config().hasura.admin_secret
      }
    });
  }
});

export const setCustomClaims = functions.auth.user().onCreate(async user => {

  try {
    // Hasuraサーバーへのユーザーデータの作成リクエスト
    functions.logger.log('*** user:',user);
    const res = await client.mutate({
      variables: { firebase_uid: user.uid, name: user.displayName || "unknown", email: user.email },
      mutation: gql`
        mutation InsertUsers($firebase_uid: String, $name: String, $email: String) {
          insert_users(objects: { firebase_uid: $firebase_uid, name: $name, email: $email }) {
            returning {
              id
              firebase_uid
              name
              email
              created_at
            }
          }
        }
      `
    });

    const uid = res.data.insert_users.returning[0].id;
    // Hasuraの検証用のカスタムクレーム（属性情報）
    const customClaims = {
      "https://hasura.io/jwt/claims": {
        "x-hasura-default-role": "user",
        "x-hasura-allowed-roles": ["user"],
        "x-hasura-user-id": uid
      }
    };

    // カスタムクレームの設定
    await admin.auth().setCustomUserClaims(user.uid, customClaims);

    // 初回ログインの際にユーザー作成と、カスタムクレームの設定には遅延があるため、
    // tokenリフレッシュのフック用にFirestoreへのmetaデータ追加を行う
    await admin
      .firestore()
      .collection("user_meta")
      .doc(user.uid)
      .create({
        refreshTime: admin.firestore.FieldValue.serverTimestamp()
      });
  } catch (e) {
    console.log(e);
  }
});

export const deleteUser = functions.auth.user().onDelete(async user => {
  try {
    // Hasuraサーバーへのユーザーデータの削除リクエスト
    functions.logger.log('*** Delete user:',user);

    const res = await client.query({
      variables: { firebase_uid: user.uid },
      query: gql`
        query QueryUser($firebase_uid: String) {
          users(where: {firebase_uid: {_eq: $firebase_uid}}) {
            id
          }
        }
      `
    });

    const userId = res.data.users[0].id;

    await client.mutate({
      variables: { id: userId },
      mutation: gql`
        mutation deleteUser($id: uuid) {
          delete_todos(where: {user_id: {_eq: $id}}) {
            affected_rows
          }
        }
      `
    });

    await client.mutate({
      variables: { id: userId },
      mutation: gql`
        mutation deleteUser($id: uuid) {
          delete_users(where: {id: {_eq: $id}}) {
            affected_rows
          }
        }
      `
    });

    // 初回ログインの際にユーザー作成と、カスタムクレームの設定には遅延があるため、
    // tokenリフレッシュのフック用にFirestoreへのmetaデータ追加を行う
    await admin
      .firestore()
      .collection("user_meta")
      .doc(user.uid)
      .delete();
  } catch (e) {
    console.log(e);
  }
});
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  ApolloClient,
  InMemoryCache,
  createHttpLink,
  ApolloLink,
  split,
  concat,
  Observable
} from '@apollo/client'
import {
  getMainDefinition,
  offsetLimitPagination
} from '@apollo/client/utilities'
import { WebSocketLink } from '@apollo/client/link/ws'
import useEnvVars from '../../environment'
import { useContext } from 'react'
import { LocationContext } from '../context/Location'
import { calculateDistance } from '../utils/customFunctions'

const setupApollo = () => {
  const { GRAPHQL_URL, WS_GRAPHQL_URL } = useEnvVars()

 // Tạo random ổn định theo ID (hash)
const stableRandom = (id, limit = 10) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
  }
  return Math.abs(hash % limit);
};

const cache = new InMemoryCache({
  typePolicies: {
    Query: {
      fields: {
        orders: offsetLimitPagination(),
      },
    },

    Category: {
      fields: {
        foods: {
          merge(_existing, incoming) {
            return incoming; // Foods không phân trang → luôn dùng dữ liệu mới
          },
        },
      },
    },

    Food: {
      fields: {
        variations: {
          merge(_existing, incoming) {
            return incoming; // Tránh lặp variation
          },
        },
      },
    },

    RestaurantPreview: {
      keyFields: ['_id'],  // Quan trọng để random ổn định
      fields: {
        /** 📌 1. Tính lại khoảng cách */
        distanceWithCurrentLocation: {
          read(_existing, { variables, readField }) {
            const lat = variables?.latitude;
            const lng = variables?.longitude;

            if (lat == null || lng == null) return null;

            const location = readField('location');
            if (!location?.coordinates) return null;

            return calculateDistance(
              location.coordinates[0],
              location.coordinates[1],
              lat,
              lng
            );
          },
        },

        /** 📌 2. Free delivery random ổn định */
        freeDelivery: {
          read(_existing, { readField }) {
            const id = readField('_id');
            return stableRandom(id) > 5;
          },
        },

        /** 📌 3. Accept voucher random ổn định */
        acceptVouchers: {
          read(_existing, { readField }) {
            const id = readField('_id');
            return stableRandom(id) < 5;
          },
        },
      },
    },
  },
});

  const httpLink = createHttpLink({
    uri: GRAPHQL_URL
  })

  const wsLink = new WebSocketLink({
    uri: WS_GRAPHQL_URL,
    options: {
      reconnect: true
    }
  })

  const request = async operation => {
    const token = await AsyncStorage.getItem('token')

    operation.setContext({
      headers: {
        authorization: token ? `Bearer ${token}` : ''
      }
    })
  }

  const requestLink = new ApolloLink(
    (operation, forward) =>
      new Observable(observer => {
        let handle
        Promise.resolve(operation)
          .then(oper => request(oper))
          .then(() => {
            handle = forward(operation).subscribe({
              next: observer.next.bind(observer),
              error: observer.error.bind(observer),
              complete: observer.complete.bind(observer)
            })
          })
          .catch(observer.error.bind(observer))

        return () => {
          if (handle) handle.unsubscribe()
        }
      })
  )

  const terminatingLink = split(({ query }) => {
    const { kind, operation } = getMainDefinition(query)
    return kind === 'OperationDefinition' && operation === 'subscription'
  }, wsLink)

  const client = new ApolloClient({
    link: concat(ApolloLink.from([terminatingLink, requestLink]), httpLink),
    cache,
    resolvers: {}
  })

  return client
}

export default setupApollo
